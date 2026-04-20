import { useSyncExternalStore } from 'react';
import type { TranscriptionSnapshot, WsMessage } from '../contracts';
import { fetchTranscriptionSnapshot } from './api';
import { WsClient } from './ws-client';

/**
 * Host WhisperX transcription activity store. Mirrors the server-side
 * TranscriptionService:
 *  - REST hydrate on mount pulls the current snapshot at connect time
 *  - WS frames { type: 'transcription', snapshot } replace state wholesale
 *
 * Independent WsClient (same pattern as live-store / signals-store). Frames
 * not matching 'transcription' are silently dropped.
 *
 * WsMessage union widens whenever the server adds a frame type; the
 * discriminated check here keeps us forward-compatible.
 */

const EMPTY_SNAPSHOT: TranscriptionSnapshot = {
  active: [],
  queued: [],
  recentTerminal: [],
};

type Listener = () => void;

class TranscriptionStore {
  private snapshot: TranscriptionSnapshot = EMPTY_SNAPSHOT;
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

  getSnapshot = (): TranscriptionSnapshot => this.snapshot;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private async hydrateFromFetch(): Promise<void> {
    try {
      const snap = await fetchTranscriptionSnapshot();
      this.snapshot = snap;
      this.emit();
    } catch {
      // swallow — WS will catch up
    }
  }

  private onFrame(msg: WsMessage): void {
    if (msg.type !== 'transcription') return;
    this.snapshot = msg.snapshot;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export const transcriptionStore = new TranscriptionStore();

export function useTranscriptionSnapshot(): TranscriptionSnapshot {
  return useSyncExternalStore(
    transcriptionStore.subscribe,
    transcriptionStore.getSnapshot,
    transcriptionStore.getSnapshot,
  );
}
