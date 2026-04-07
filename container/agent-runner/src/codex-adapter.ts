/**
 * Codex SDK Adapter
 * Extracted from the original monolithic index.ts.
 * Uses @openai/codex-sdk with Thread-based execution.
 */

import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';
import {
  writeOutput, log, drainIpcInput, shouldClose, appendConversationArchive,
  IPC_POLL_MS,
} from './shared.js';
import type { SdkAdapter, SdkInitOptions, RunQueryOptions, RunQueryResult } from './sdk-adapter.js';

export class CodexAdapter implements SdkAdapter {
  private codex!: Codex;
  private thread: Thread | null = null;
  private threadOpts!: {
    workingDirectory: string;
    skipGitRepoCheck: boolean;
    approvalPolicy: 'never';
    sandboxMode: 'danger-full-access';
    networkAccessEnabled: boolean;
    webSearchEnabled: boolean;
    additionalDirectories?: string[];
  };
  private assistantName?: string;

  init(options: SdkInitOptions): void {
    this.assistantName = options.containerInput.assistantName;

    this.codex = new Codex({
      config: {
        mcp_servers: {
          nanoclaw: {
            command: 'node',
            args: [options.mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: options.containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: options.containerInput.groupFolder,
              NANOCLAW_IS_MAIN: options.containerInput.isMain ? '1' : '0',
            },
          },
        },
        instructions: options.instructions,
      },
    });

    this.threadOpts = {
      workingDirectory: '/workspace/group',
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
      networkAccessEnabled: true,
      webSearchEnabled: true,
      additionalDirectories: options.extraDirs.length > 0 ? options.extraDirs : undefined,
    };
  }

  private getOrCreateThread(sessionId?: string): Thread {
    if (this.thread) return this.thread;

    if (sessionId) {
      try {
        this.thread = this.codex.resumeThread(sessionId, this.threadOpts);
        log(`Resuming thread: ${sessionId}`);
        return this.thread;
      } catch (err) {
        log(`Failed to resume thread ${sessionId}, starting fresh: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.thread = this.codex.startThread(this.threadOpts);
    log('Starting new thread');
    return this.thread;
  }

  async runQuery(prompt: string, options: RunQueryOptions): Promise<RunQueryResult> {
    const abortController = new AbortController();
    let closedDuringQuery = false;
    let ipcPolling = true;

    // IPC polling: close sentinel only, mid-turn messages are drained and dropped
    const pollIpc = () => {
      if (!ipcPolling) return;
      if (shouldClose()) {
        log('Close sentinel detected during query, aborting turn');
        closedDuringQuery = true;
        abortController.abort();
        ipcPolling = false;
        return;
      }
      drainIpcInput();
      setTimeout(pollIpc, IPC_POLL_MS);
    };
    setTimeout(pollIpc, IPC_POLL_MS);

    let newSessionId: string | undefined;
    let resultText: string | null = null;
    let resultCount = 0;

    const thread = this.getOrCreateThread(options.sessionId);

    try {
      const { events } = await thread.runStreamed(prompt, {
        signal: abortController.signal,
      });

      for await (const event of events) {
        switch (event.type) {
          case 'thread.started':
            newSessionId = (event as { thread_id: string }).thread_id;
            log(`Thread initialized: ${newSessionId}`);
            break;

          case 'item.completed': {
            const item = (event as { item: { type: string; text?: string; message?: string } }).item;
            if (item.type === 'agent_message' && item.text) {
              resultCount++;
              const text = item.text.trim();
              const cleaned = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
              log(`Result #${resultCount}: ${cleaned.slice(0, 200)}`);
              if (cleaned) {
                resultText = cleaned;
                writeOutput({
                  status: 'success',
                  result: cleaned,
                  newSessionId,
                });
              }
            }
            if (item.type === 'error') {
              log(`Item error: ${item.message || 'unknown'}`);
            }
            break;
          }

          case 'turn.failed': {
            const error = (event as { error: { message: string } }).error;
            log(`Turn failed: ${error.message}`);
            throw new Error(error.message);
          }

          case 'error': {
            const msg = (event as { message: string }).message;
            log(`Stream error: ${msg}`);
            throw new Error(msg);
          }
        }
      }
    } catch (err) {
      if (closedDuringQuery && (err as Error).name === 'AbortError') {
        log('Turn aborted by close sentinel');
      } else {
        throw err;
      }
    } finally {
      ipcPolling = false;
    }

    appendConversationArchive(prompt, resultText, this.assistantName);

    log(`Query done. Results: ${resultCount}, closedDuringQuery: ${closedDuringQuery}`);
    return { newSessionId, resultText, closedDuringQuery };
  }
}
