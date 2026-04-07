/**
 * Claude Agent SDK Adapter
 * Ported from upstream qwibitai/nanoclaw (Claude SDK version).
 * Restores features lost in the Codex migration:
 * - MessageStream for mid-turn IPC message injection
 * - Native system prompt via systemPrompt.append
 * - PreCompactHook for full transcript archiving
 * - Granular session resume via resumeSessionAt (assistant UUID)
 */

import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKUserMessage,
  SDKMessage,
  PreCompactHookInput,
  HookCallback,
} from '@anthropic-ai/claude-agent-sdk';
import {
  writeOutput, log, drainIpcInput, shouldClose,
  IPC_POLL_MS,
} from './shared.js';
import type { SdkAdapter, SdkInitOptions, RunQueryOptions, RunQueryResult } from './sdk-adapter.js';
import type { ContainerInput } from './shared.js';

/**
 * Push-based async iterable for mid-turn message injection.
 * Keeps itself alive until end() is called, preventing single-turn behavior
 * so agent teams and subagents can execute fully.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

export class ClaudeAdapter implements SdkAdapter {
  private mcpServers!: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  private globalClaudeMd = '';
  private containerInput!: ContainerInput;
  private extraDirs: string[] = [];

  init(options: SdkInitOptions): void {
    this.containerInput = options.containerInput;
    this.globalClaudeMd = options.globalInstructions;
    this.extraDirs = options.extraDirs;

    this.mcpServers = {
      nanoclaw: {
        command: 'node',
        args: [options.mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: options.containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: options.containerInput.groupFolder,
          NANOCLAW_IS_MAIN: options.containerInput.isMain ? '1' : '0',
        },
      },
    };
  }

  async runQuery(prompt: string, options: RunQueryOptions): Promise<RunQueryResult> {
    const stream = new MessageStream();
    stream.push(prompt);
    let closedDuringQuery = false;
    let ipcPolling = true;

    // IPC polling: push mid-turn messages into MessageStream
    const pollIpc = () => {
      if (!ipcPolling) return;
      if (shouldClose()) {
        log('Close sentinel detected during query, ending stream');
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
        return;
      }
      for (const text of drainIpcInput()) {
        log(`Piping IPC message into active query (${text.length} chars)`);
        stream.push(text);
      }
      setTimeout(pollIpc, IPC_POLL_MS);
    };
    setTimeout(pollIpc, IPC_POLL_MS);

    let newSessionId: string | undefined;
    let lastAssistantUuid: string | undefined;
    let resultText: string | null = null;
    let resultCount = 0;

    const sdkEnv: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
    };

    const queryOptions = {
      cwd: '/workspace/group',
      additionalDirectories: this.extraDirs.length > 0 ? this.extraDirs : undefined,
      resume: options.sessionId,
      resumeSessionAt: options.resumeAt,
      systemPrompt: this.globalClaudeMd
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: this.globalClaudeMd,
          }
        : undefined,
      allowedTools: [
        'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch', 'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage', 'TodoWrite',
        'ToolSearch', 'Skill', 'NotebookEdit',
        'mcp__nanoclaw__*',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'] as ('project' | 'user')[],
      mcpServers: this.mcpServers,
      hooks: {
        PreCompact: [
          { hooks: [this.createPreCompactHook()] },
        ],
      },
    };

    try {
      for await (const message of query({ prompt: stream, options: queryOptions })) {
        const msg = message as SDKMessage & { type: string; uuid?: string; text?: string };

        // Track session ID from init message
        if (msg.type === 'system' && 'session_id' in msg) {
          newSessionId = (msg as { session_id: string }).session_id;
          log(`Session initialized: ${newSessionId}`);
        }

        // Track assistant UUID for granular resume
        if (msg.type === 'assistant' && msg.uuid) {
          lastAssistantUuid = msg.uuid;
        }

        // Emit results
        if (msg.type === 'result') {
          resultCount++;
          const res = msg as Record<string, unknown>;
          const text = ((res.result as string) || (msg.text as string) || '').trim();
          const cleaned = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
          log(`Result #${resultCount}: ${cleaned.slice(0, 200)}`);
          if (res.is_error) {
            throw new Error(`Claude Code returned an error result: ${cleaned || text}`);
          }
          if (cleaned) {
            resultText = cleaned;
            writeOutput({
              status: 'success',
              result: cleaned,
              newSessionId,
            });
          }
        }
      }
    } finally {
      ipcPolling = false;
    }

    log(`Query done. Results: ${resultCount}, closedDuringQuery: ${closedDuringQuery}`);
    return { newSessionId, lastAssistantUuid, resultText, closedDuringQuery };
  }

  private createPreCompactHook(): HookCallback {
    const assistantName = this.containerInput.assistantName;

    return async (input: unknown) => {
      const preCompact = input as PreCompactHookInput;
      const transcriptPath = preCompact.transcript_path;

      if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        log('No transcript found for archiving');
        return {};
      }

      try {
        const content = fs.readFileSync(transcriptPath, 'utf-8');
        const conversationsDir = '/workspace/group/conversations';
        fs.mkdirSync(conversationsDir, { recursive: true });

        const date = new Date().toISOString().split('T')[0];
        const name = assistantName || 'conversation';
        const filename = `${date}-${name}.md`;
        const filePath = path.join(conversationsDir, filename);

        fs.writeFileSync(filePath, content);
        log(`Archived conversation to ${filePath}`);
      } catch (err) {
        log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
      }

      return {};
    };
  }
}
