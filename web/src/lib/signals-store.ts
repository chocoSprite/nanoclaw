import { useSyncExternalStore } from 'react';
import type { LogSignal, WsMessage } from '../contracts';
import { fetchSignals } from './api';
import { WsClient } from './ws-client';

/**
 * Active-log-signals store. Mirrors signals-service state over WS + REST:
 *  - REST hydrate on mount pulls the active set at connect time
 *  - WS frames { type: 'signal', status, signal } upsert/remove
 *
 * Independent WsClient (same pattern as LogsPage / live-store) — frames not
 * matching 'signal' are silently dropped. Refactoring into a shared
 * multiplexer is a future optimization; today this keeps blast radius small.
 */

interface StoreState {
  signals: Map<number, LogSignal>;
}

type Listener = () => void;

class SignalsStore {
  private state: StoreState = { signals: new Map() };
  private cachedActive: LogSignal[] = [];
  private readonly listeners = new Set<Listener>();
  private ws: WsClient | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.hydrateFromFetch();
    this.ws = new WsClient({ onFrame: (msg) => this.onFrame(msg) });
    this.ws.start();
  }

  stop(): void {
    this.ws?.stop();
    this.ws = null;
    this.started = false;
  }

  getSnapshot = (): LogSignal[] => this.cachedActive;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  dismissLocal(id: number): void {
    // Optimistic removal; WS 'signal:resolved' is expected to follow.
    if (!this.state.signals.has(id)) return;
    const next = new Map(this.state.signals);
    next.delete(id);
    this.state = { signals: next };
    this.recompute();
    this.emit();
  }

  private async hydrateFromFetch(): Promise<void> {
    try {
      const list = await fetchSignals('active');
      const next = new Map<number, LogSignal>();
      for (const s of list) next.set(s.id, s);
      this.state = { signals: next };
      this.recompute();
      this.emit();
    } catch {
      // swallow — WS will catch up
    }
  }

  private onFrame(msg: WsMessage): void {
    if (msg.type !== 'signal') return;
    const next = new Map(this.state.signals);
    if (msg.status === 'active') {
      next.set(msg.signal.id, msg.signal);
    } else {
      next.delete(msg.signal.id);
    }
    this.state = { signals: next };
    this.recompute();
    this.emit();
  }

  private recompute(): void {
    this.cachedActive = Array.from(this.state.signals.values()).sort(
      (a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen),
    );
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export const signalsStore = new SignalsStore();

export function useActiveSignals(): LogSignal[] {
  return useSyncExternalStore(
    signalsStore.subscribe,
    signalsStore.getSnapshot,
    signalsStore.getSnapshot,
  );
}

export function useActiveSignalCount(): number {
  return useActiveSignals().length;
}

export function useSignalById(id: number | null): LogSignal | undefined {
  const list = useActiveSignals();
  if (id == null) return undefined;
  return list.find((s) => s.id === id);
}
