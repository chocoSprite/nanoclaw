import type { AgentEventBus, AgentEventV1 } from '../agent-events.js';
import type {
  ContainerStatus,
  RecentToolCall,
  SdkKind,
  SessionUsageSnapshot,
} from './events.js';

/**
 * Per-jid live state derived from the event stream. Drives the "currentTool"
 * shown on LiveCard plus the coarse containerStatus indicator. Reducer rules
 * match the plan spec:
 *
 *   status.started     → containerStatus='running', sdk set, recentTools reset,
 *                        sessionId captured (if present on the event)
 *   tool.use           → currentTool=name, lastToolAt=ts, unshift RecentToolCall
 *                        (cap 5, drop oldest)
 *   tool.result        → find matching toolUseId in recentTools and set isError;
 *                        fall back to newest entry when toolUseId missing
 *   status.ended       → currentTool=null, containerStatus=idle|error
 *   container.spawned  → containerStatus='running' if unknown
 *   container.exited   → if exitCode!==0 then 'error'; else clamp idle
 *                        (recentTools and sessionId preserved across the next
 *                        status.started so the card still shows what happened)
 */
export const RECENT_TOOLS_CAP = 5;

export interface LiveJidState {
  currentTool: string | null;
  lastToolAt: string | null;
  containerStatus: ContainerStatus;
  sdk: SdkKind | null;
  recentTools: RecentToolCall[];
  sessionId: string | null;
  lastUsage: SessionUsageSnapshot | null;
}

function emptyState(): LiveJidState {
  return {
    currentTool: null,
    lastToolAt: null,
    containerStatus: 'idle',
    sdk: null,
    recentTools: [],
    sessionId: null,
    lastUsage: null,
  };
}

export class LiveStateCache {
  private readonly byJid = new Map<string, LiveJidState>();
  private off: (() => void) | null = null;

  subscribe(bus: AgentEventBus): void {
    this.off?.();
    this.off = bus.on('*', (ev) => this.apply(ev));
  }

  detach(): void {
    this.off?.();
    this.off = null;
  }

  apply(ev: AgentEventV1): void {
    const jid = ev.chatJid;
    if (!jid) return;
    const s = this.byJid.get(jid) ?? emptyState();

    switch (ev.kind) {
      case 'status.started':
        s.containerStatus = 'running';
        s.sdk = ev.sdk;
        s.sessionId = ev.sessionId ?? null;
        // New session boundary — clear the history so the card stops showing
        // the previous turn's tools, and drop lastUsage so the gauge starts
        // from zero rather than carrying last session's numbers.
        s.recentTools = [];
        s.lastUsage = null;
        break;
      case 'status.ended':
        s.currentTool = null;
        s.containerStatus = ev.outcome === 'error' ? 'error' : 'idle';
        break;
      case 'container.spawned':
        if (s.containerStatus === 'idle') s.containerStatus = 'running';
        break;
      case 'container.exited':
        if (ev.exitCode !== 0 && ev.exitCode !== null) {
          s.containerStatus = 'error';
        } else if (s.containerStatus === 'running') {
          s.containerStatus = 'idle';
          s.currentTool = null;
        }
        break;
      case 'tool.use': {
        s.currentTool = ev.toolName;
        s.lastToolAt = ev.ts;
        const entry: RecentToolCall = {
          toolName: ev.toolName,
          at: ev.ts,
        };
        if (ev.inputSummary !== undefined) entry.inputSummary = ev.inputSummary;
        if (ev.toolUseId !== undefined) entry.toolUseId = ev.toolUseId;
        s.recentTools = [entry, ...s.recentTools].slice(0, RECENT_TOOLS_CAP);
        break;
      }
      case 'tool.result': {
        // Keep currentTool visible (no flicker) but stamp the matching history
        // entry's isError so the UI can color it.
        if (s.recentTools.length === 0) break;
        const next = s.recentTools.slice();
        let idx = -1;
        if (ev.toolUseId !== undefined) {
          idx = next.findIndex((t) => t.toolUseId === ev.toolUseId);
        }
        if (idx < 0) idx = 0; // newest entry fallback
        next[idx] = { ...next[idx], isError: ev.isError };
        s.recentTools = next;
        break;
      }
      case 'session.usage': {
        const snap: SessionUsageSnapshot = {
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
        };
        if (ev.cacheReadTokens !== undefined)
          snap.cacheReadTokens = ev.cacheReadTokens;
        if (ev.cacheCreationTokens !== undefined)
          snap.cacheCreationTokens = ev.cacheCreationTokens;
        if (ev.model !== undefined) snap.model = ev.model;
        s.lastUsage = snap;
        break;
      }
    }

    this.byJid.set(jid, s);
  }

  get(jid: string): LiveJidState | undefined {
    return this.byJid.get(jid);
  }

  entries(): Array<[string, LiveJidState]> {
    return Array.from(this.byJid.entries());
  }

  clear(): void {
    this.byJid.clear();
  }
}
