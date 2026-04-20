/**
 * Codex SDK Adapter
 * Extracted from the original monolithic index.ts.
 * Uses @openai/codex-sdk with Thread-based execution.
 */

import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';
import {
  writeOutput,
  log,
  drainIpcInput,
  shouldClose,
  appendConversationArchive,
  IPC_POLL_MS,
  createEventEmitter,
} from './shared.js';
import type { ContainerInput } from './shared.js';
import type {
  SdkAdapter,
  SdkInitOptions,
  RunQueryOptions,
  RunQueryResult,
} from './sdk-adapter.js';
import { codexUsageDelta } from './codex-usage.js';
import type { CodexUsageBaseline } from './codex-usage.js';

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
    model?: string;
  };
  private assistantName?: string;
  private containerInput!: ContainerInput;
  /**
   * Previous cumulative usage observed for the current thread. Codex's
   * `turn.completed.usage` is cumulative across the thread (see
   * {@link ./codex-usage.ts}), so we hold this to compute per-turn deltas.
   * Reset to `null` on new-thread creation and resume-fallback.
   */
  private lastUsage: CodexUsageBaseline | null = null;

  init(options: SdkInitOptions): void {
    this.assistantName = options.containerInput.assistantName;
    this.containerInput = options.containerInput;

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
      additionalDirectories:
        options.extraDirs.length > 0 ? options.extraDirs : undefined,
      // Per-group model override. When unset, Codex CLI falls back to
      // ~/.codex/config.toml's global default. Spread-conditionally so we
      // never pass `model: undefined` — the SDK would forward it as a
      // literal `undefined` TOML override.
      ...(options.containerInput.model
        ? { model: options.containerInput.model }
        : {}),
    };
  }

  private getOrCreateThread(sessionId?: string): Thread {
    if (this.thread) return this.thread;

    if (sessionId) {
      try {
        this.thread = this.codex.resumeThread(sessionId, this.threadOpts);
        log(`Resuming thread: ${sessionId}`);
        // Resume edge: the CLI's internal cumulative counter may already
        // be non-zero when we attach. Baseline starts at null, so the
        // first delta on resume equals the at-resume cumulative — one
        // inflated turn, then self-corrects.
        this.lastUsage = null;
        return this.thread;
      } catch (err) {
        log(
          `Failed to resume thread ${sessionId}, starting fresh: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.thread = this.codex.startThread(this.threadOpts);
    log('Starting new thread');
    this.lastUsage = null;
    return this.thread;
  }

  async runQuery(
    prompt: string,
    options: RunQueryOptions,
  ): Promise<RunQueryResult> {
    const abortController = new AbortController();
    let closedDuringQuery = false;
    let ipcPolling = true;

    // Dashboard event stream. Codex SDK does not expose tool_use as discrete
    // events (only the rendered item.text post-execution), so we emit only
    // the coarse status.* lifecycle. The host additionally emits
    // container.spawned/exited, giving Codex cards a meaningful state.
    const emit = createEventEmitter(this.containerInput);
    let statusStartedEmitted = false;
    let endedEmitted = false;
    const emitEnd = (outcome: 'success' | 'error', error?: string): void => {
      if (endedEmitted) return;
      endedEmitted = true;
      if (!statusStartedEmitted) {
        emit({ kind: 'status.started', sdk: 'codex' });
        statusStartedEmitted = true;
      }
      emit({ kind: 'status.ended', outcome, error });
    };

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
            if (!statusStartedEmitted) {
              emit({
                kind: 'status.started',
                sdk: 'codex',
                sessionId: newSessionId,
              });
              statusStartedEmitted = true;
            }
            break;

          case 'item.completed': {
            const item = (
              event as {
                item: { type: string; text?: string; message?: string };
              }
            ).item;
            if (item.type === 'agent_message' && item.text) {
              resultCount++;
              const text = item.text.trim();
              const cleaned = text
                .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                .trim();
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

          case 'turn.completed': {
            const usage = (
              event as {
                usage?: {
                  input_tokens?: number;
                  cached_input_tokens?: number;
                  output_tokens?: number;
                };
              }
            ).usage;
            if (usage) {
              // Codex emits cumulative thread totals — convert to per-turn
              // delta so the gauge matches Claude's per-turn `msg.usage`.
              // `cached_input_tokens` is a breakdown of `input_tokens`
              // (not an additive sibling), so we deliberately do NOT
              // emit `cacheReadTokens` — the web-side totalContextTokens
              // sums input+cacheRead+cacheCreation (Anthropic contract),
              // and adding Codex's cache subset would double-count.
              // See: ./codex-usage.ts, codex#17539, promptfoo#7546.
              const { deltaInput, deltaOutput, nextBaseline } =
                codexUsageDelta(usage, this.lastUsage);
              this.lastUsage = nextBaseline;
              const payload: {
                kind: 'session.usage';
                inputTokens: number;
                outputTokens: number;
                model?: string;
              } = {
                kind: 'session.usage',
                inputTokens: deltaInput,
                outputTokens: deltaOutput,
              };
              if (this.containerInput.model)
                payload.model = this.containerInput.model;
              emit(payload);
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
      emitEnd('success');
    } catch (err) {
      if (closedDuringQuery && (err as Error).name === 'AbortError') {
        log('Turn aborted by close sentinel');
        emitEnd('success');
      } else {
        emitEnd('error', err instanceof Error ? err.message : String(err));
        throw err;
      }
    } finally {
      ipcPolling = false;
    }

    appendConversationArchive(prompt, resultText, this.assistantName);

    log(
      `Query done. Results: ${resultCount}, closedDuringQuery: ${closedDuringQuery}`,
    );
    return { newSessionId, resultText, closedDuringQuery };
  }
}
