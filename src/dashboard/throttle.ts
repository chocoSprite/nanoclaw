import type { AgentEventV1 } from '../agent-events.js';

/**
 * Per-jid coalescer. Requirements (plan step 2):
 *   - same toolName back-to-back → skip within the window
 *   - different toolName → emit immediately (and reset timer)
 *   - status / container events → always emit immediately (state transitions)
 *
 * Not a true 1 Hz rate-limiter; the window only gates *repeat* tool.use
 * for a single toolName. This is what the LivePage actually cares about —
 * floods of `Read` blocks should collapse into one card update, but a
 * Read→Grep→Read sequence is genuinely informative and passes through.
 */
const DEFAULT_WINDOW_MS = 1_000;

interface PerKeyState {
  lastToolName: string | null;
  lastToolAt: number;
}

export class EventThrottle {
  private readonly perKey = new Map<string, PerKeyState>();

  constructor(
    private readonly emit: (ev: AgentEventV1) => void,
    private readonly windowMs: number = DEFAULT_WINDOW_MS,
  ) {}

  push(ev: AgentEventV1, now: number = Date.now()): void {
    const key = ev.chatJid ?? ev.groupFolder;
    const state = this.perKey.get(key) ?? {
      lastToolName: null,
      lastToolAt: 0,
    };

    if (ev.kind === 'tool.use') {
      const sameName = ev.toolName === state.lastToolName;
      const withinWindow = now - state.lastToolAt < this.windowMs;
      if (sameName && withinWindow) {
        return;
      }
      state.lastToolName = ev.toolName;
      state.lastToolAt = now;
      this.perKey.set(key, state);
      this.emit(ev);
      return;
    }

    if (ev.kind === 'status.ended' || ev.kind === 'container.exited') {
      state.lastToolName = null;
      state.lastToolAt = 0;
      this.perKey.set(key, state);
    }

    this.emit(ev);
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.perKey.clear();
      return;
    }
    this.perKey.delete(key);
  }
}
