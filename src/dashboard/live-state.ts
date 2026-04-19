import type { AgentEventBus, AgentEventV1 } from '../agent-events.js';
import type { ContainerStatus, SdkKind } from './events.js';

/**
 * Per-jid live state derived from the event stream. Drives the "currentTool"
 * shown on LiveCard plus the coarse containerStatus indicator. Reducer rules
 * match the plan spec:
 *
 *   status.started     → containerStatus='running', sdk set
 *   tool.use           → currentTool=name, lastToolAt=ts (Claude only)
 *   tool.result        → no change (keep last tool visible)
 *   status.ended       → currentTool=null, containerStatus=idle|error
 *   container.spawned  → containerStatus='running' if unknown
 *   container.exited   → if exitCode!==0 then 'error'; else clamp idle
 */
export interface LiveJidState {
  currentTool: string | null;
  lastToolAt: string | null;
  containerStatus: ContainerStatus;
  sdk: SdkKind | null;
}

function emptyState(): LiveJidState {
  return {
    currentTool: null,
    lastToolAt: null,
    containerStatus: 'idle',
    sdk: null,
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
      case 'tool.use':
        s.currentTool = ev.toolName;
        s.lastToolAt = ev.ts;
        break;
      case 'tool.result':
        // Intentional no-op: keep the last tool name visible on the card
        // so it doesn't flicker between use/result pairs. isError handling
        // is for the frontend (flicker class).
        break;
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
