import { useSyncExternalStore } from 'react';
import type {
  AgentEventV1,
  LiveGroupState,
  RegisteredGroupLite,
  WsMessage,
} from '../contracts';
import { WsClient, type WsStatus } from './ws-client';

/**
 * In-memory live store for the LivePage. Holds the current Map<jid, LiveGroupState>
 * plus WS status, applies incoming WsMessage frames via a reducer that mirrors
 * src/dashboard/live-state.ts on the server.
 *
 * Subscribers come via `useLiveGroups()` (useSyncExternalStore) — snapshot is
 * an array sorted by name so React key stability is trivial.
 */

interface StoreState {
  groups: Map<string, LiveGroupState>;
  status: WsStatus;
}

type Listener = () => void;

class LiveStore {
  private state: StoreState = {
    groups: new Map(),
    status: 'connecting',
  };
  private cachedList: LiveGroupState[] = [];
  private readonly listeners = new Set<Listener>();
  private ws: WsClient | null = null;

  startWs(): void {
    if (this.ws) return;
    this.ws = new WsClient({
      onFrame: (msg) => this.onFrame(msg),
      onStatus: (status) => this.setStatus(status),
    });
    this.ws.start();
  }

  stopWs(): void {
    this.ws?.stop();
    this.ws = null;
  }

  hydrate(groups: LiveGroupState[]): void {
    const next = new Map<string, LiveGroupState>();
    for (const g of groups) next.set(g.jid, { ...g });
    this.state = { ...this.state, groups: next };
    this.recomputeList();
    this.emit();
  }

  getSnapshot = (): LiveGroupState[] => this.cachedList;

  getStatus = (): WsStatus => this.state.status;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private setStatus(status: WsStatus): void {
    if (this.state.status === status) return;
    this.state = { ...this.state, status };
    this.emit();
  }

  private onFrame(msg: WsMessage): void {
    switch (msg.type) {
      case 'snapshot':
        this.hydrate(msg.groups);
        break;
      case 'event':
        this.applyEvent(msg.event);
        break;
      case 'roster':
        this.applyRoster(msg.groups);
        break;
    }
  }

  private applyEvent(ev: AgentEventV1): void {
    const jid = ev.chatJid;
    if (!jid) return;
    const prev = this.state.groups.get(jid);
    if (!prev) return; // event for unknown group — wait for next snapshot/roster

    const next: LiveGroupState = { ...prev };
    switch (ev.kind) {
      case 'status.started':
        next.containerStatus = 'running';
        next.sdk = ev.sdk;
        break;
      case 'status.ended':
        next.currentTool = null;
        next.containerStatus = ev.outcome === 'error' ? 'error' : 'idle';
        break;
      case 'container.spawned':
        if (next.containerStatus === 'idle') next.containerStatus = 'running';
        break;
      case 'container.exited':
        if (ev.exitCode !== 0 && ev.exitCode !== null) {
          next.containerStatus = 'error';
        } else if (next.containerStatus === 'running') {
          next.containerStatus = 'idle';
          next.currentTool = null;
        }
        break;
      case 'tool.use':
        next.currentTool = ev.toolName;
        next.lastToolAt = ev.ts;
        break;
      case 'tool.result':
        // intentional no-op — prevents card flicker between use/result
        break;
      default:
        return; // unknown kind — drop
    }

    const map = new Map(this.state.groups);
    map.set(jid, next);
    this.state = { ...this.state, groups: map };
    this.recomputeList();
    this.emit();
  }

  private applyRoster(roster: RegisteredGroupLite[]): void {
    // Safety net: clamp inactive groups to idle so stale running states cannot
    // stick. Plan spec allows this; in P0 the server doesn't emit roster but
    // the reducer is ready when it does.
    const byJid = new Map(roster.map((g) => [g.jid, g]));
    const map = new Map(this.state.groups);
    let dirty = false;
    for (const [jid, g] of map) {
      const reg = byJid.get(jid);
      if (reg && !reg.active && g.containerStatus === 'running') {
        map.set(jid, { ...g, containerStatus: 'idle', currentTool: null });
        dirty = true;
      }
    }
    if (dirty) {
      this.state = { ...this.state, groups: map };
      this.recomputeList();
      this.emit();
    }
  }

  private recomputeList(): void {
    this.cachedList = Array.from(this.state.groups.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export const liveStore = new LiveStore();

export function useLiveGroups(): LiveGroupState[] {
  return useSyncExternalStore(
    liveStore.subscribe,
    liveStore.getSnapshot,
    liveStore.getSnapshot,
  );
}

export function useWsStatus(): WsStatus {
  return useSyncExternalStore(
    liveStore.subscribe,
    liveStore.getStatus,
    liveStore.getStatus,
  );
}
