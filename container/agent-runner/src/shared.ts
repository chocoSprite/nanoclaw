/**
 * Shared utilities for SDK adapters.
 * Both Codex and Claude adapters import these.
 */

import fs from 'fs';
import path from 'path';

export const IPC_INPUT_DIR = '/workspace/ipc/input';
export const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
export const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const EVENT_START_MARKER = '---NANOCLAW_EVENT_V1_START---';
const EVENT_END_MARKER = '---NANOCLAW_EVENT_V1_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  sdk: 'codex' | 'claude';
  model?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

/**
 * Event schema v1 — wire format between agent-runner and the host dashboard.
 * Mirror of src/agent-events.ts AgentEventV1, minus host-only events
 * (container.spawned/container.exited) which the host emits itself.
 */
interface EventBase {
  v: 1;
  kind: string;
  ts: string;
  groupFolder: string;
  chatJid?: string;
}

export type AgentEventV1Payload =
  | (EventBase & {
      kind: 'status.started';
      sdk: 'claude' | 'codex';
      sessionId?: string;
    })
  | (EventBase & {
      kind: 'status.ended';
      outcome: 'success' | 'error';
      error?: string;
    })
  | (EventBase & {
      kind: 'tool.use';
      toolName: string;
      toolUseId?: string;
      inputSummary?: string;
    })
  | (EventBase & {
      kind: 'tool.result';
      toolUseId?: string;
      isError: boolean;
    });

type EventInput =
  | { kind: 'status.started'; sdk: 'claude' | 'codex'; sessionId?: string }
  | { kind: 'status.ended'; outcome: 'success' | 'error'; error?: string }
  | {
      kind: 'tool.use';
      toolName: string;
      toolUseId?: string;
      inputSummary?: string;
    }
  | { kind: 'tool.result'; toolUseId?: string; isError: boolean };

export type AgentEventEmitter = (ev: EventInput) => void;

/**
 * Write a single EVENT_V1 marker block to stdout. Host's container-runner
 * parser pulls these out of the stream alongside OUTPUT markers. Emission
 * must never throw — bad event data cannot be allowed to break the agent.
 */
export function writeEvent(ev: AgentEventV1Payload): void {
  try {
    console.log(EVENT_START_MARKER);
    console.log(JSON.stringify(ev));
    console.log(EVENT_END_MARKER);
  } catch {
    // ignore — event emission is best-effort
  }
}

/**
 * Returns an emitter with groupFolder/chatJid bound from ContainerInput.
 * Adapters get a zero-boilerplate `emit({kind:'tool.use',toolName:'Read'})`
 * call site.
 */
export function createEventEmitter(input: ContainerInput): AgentEventEmitter {
  return (ev) => {
    const payload = {
      v: 1 as const,
      ts: new Date().toISOString(),
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      ...ev,
    };
    writeEvent(payload as AgentEventV1Payload);
  };
}

export function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Check for _close sentinel.
 */
export function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
export function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
export function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Append a conversation turn to the archive file.
 * Used by Codex adapter. Claude adapter uses PreCompactHook instead.
 */
export function appendConversationArchive(
  prompt: string,
  result: string | null,
  assistantName?: string,
): void {
  if (!result) return;

  const conversationsDir = '/workspace/group/conversations';
  fs.mkdirSync(conversationsDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const filename = `${date}-conversation.md`;
  const filePath = path.join(conversationsDir, filename);

  const sender = assistantName || 'Assistant';
  const timestamp = new Date().toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const entry = [
    `**User** (${timestamp}): ${prompt.length > 500 ? prompt.slice(0, 500) + '...' : prompt}`,
    '',
    `**${sender}**: ${result.length > 2000 ? result.slice(0, 2000) + '...' : result}`,
    '',
    '---',
    '',
  ].join('\n');

  fs.appendFileSync(filePath, entry);
}
