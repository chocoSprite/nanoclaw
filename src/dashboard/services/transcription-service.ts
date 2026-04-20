/**
 * Dashboard transcription service — subscribes to the host transcription
 * event bus and maintains an in-memory view of what WhisperX is currently
 * doing (and what's queued behind it). Drives the LivePage "🎙️ transcribing"
 * banner + REST snapshot endpoint.
 *
 * State machine per audioPath id:
 *   queued  → running → (completed | failed)   // cleared from state after
 *   running → (completed | failed)              //   brief "terminal" window
 *
 * Terminal entries (completed/failed) are kept for `TERMINAL_RETAIN_MS` so
 * the banner can flash "completed in 2m 31s" before fading. Older terminals
 * are pruned lazily on each event.
 */

import path from 'node:path';

import { logger } from '../../logger.js';
import {
  transcriptionEvents,
  type TranscriptionEvent,
  type TranscriptionEventBus,
} from '../../transcription-events.js';
import { runInIsolation } from '../isolation.js';

/** Wire shape surfaced to REST + WS. Matches `web/src/contracts.ts`. */
export interface TranscriptionEntry {
  id: string;
  audioPath: string;
  fileName: string;
  sizeBytes: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  queuePosition?: number;
  stage?: string;
  stageT?: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  outputPath?: string;
}

export interface TranscriptionSnapshot {
  active: TranscriptionEntry[];
  queued: TranscriptionEntry[];
  recentTerminal: TranscriptionEntry[];
}

export interface TranscriptionServiceOptions {
  events?: TranscriptionEventBus;
  onChange: (snapshot: TranscriptionSnapshot) => void;
  /** How long to keep completed/failed entries in the snapshot. Default 30s. */
  terminalRetainMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_TERMINAL_RETAIN_MS = 30_000;

export class TranscriptionService {
  private readonly state = new Map<string, TranscriptionEntry>();
  private readonly terminalPrunedAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly terminalRetainMs: number;
  private readonly onChange: (snapshot: TranscriptionSnapshot) => void;
  private readonly events: TranscriptionEventBus;
  private unsubscribe: (() => void) | null = null;

  constructor(opts: TranscriptionServiceOptions) {
    this.events = opts.events ?? transcriptionEvents;
    this.onChange = opts.onChange;
    this.terminalRetainMs = opts.terminalRetainMs ?? DEFAULT_TERMINAL_RETAIN_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.events.on('*', (ev) => {
      runInIsolation(() => this.handle(ev), 'transcription-service.handle');
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  getSnapshot(): TranscriptionSnapshot {
    this.pruneExpiredTerminals();
    const all = Array.from(this.state.values());
    return {
      active: all.filter((e) => e.status === 'running'),
      queued: all
        .filter((e) => e.status === 'queued')
        .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0)),
      recentTerminal: all
        .filter((e) => e.status === 'completed' || e.status === 'failed')
        .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '')),
    };
  }

  private handle(ev: TranscriptionEvent): void {
    switch (ev.kind) {
      case 'transcription.queued': {
        this.state.set(ev.id, {
          id: ev.id,
          audioPath: ev.audioPath,
          fileName: path.basename(ev.audioPath),
          sizeBytes: ev.sizeBytes,
          status: 'queued',
          queuePosition: ev.queuePosition,
          queuedAt: ev.ts,
        });
        break;
      }
      case 'transcription.started': {
        const prev = this.state.get(ev.id);
        this.state.set(ev.id, {
          id: ev.id,
          audioPath: ev.audioPath,
          fileName: path.basename(ev.audioPath),
          sizeBytes: ev.sizeBytes,
          status: 'running',
          startedAt: ev.ts,
          queuedAt: prev?.queuedAt,
        });
        break;
      }
      case 'transcription.progress': {
        const prev = this.state.get(ev.id);
        if (!prev) break; // progress for an unknown job → ignore (race)
        this.state.set(ev.id, {
          ...prev,
          stage: ev.stage,
          ...(ev.t ? { stageT: ev.t } : { stageT: undefined }),
        });
        break;
      }
      case 'transcription.completed': {
        const prev = this.state.get(ev.id);
        if (!prev) break;
        this.state.set(ev.id, {
          ...prev,
          status: 'completed',
          finishedAt: ev.ts,
          durationMs: ev.durationMs,
          outputPath: ev.outputPath,
        });
        this.terminalPrunedAt.set(ev.id, this.now());
        break;
      }
      case 'transcription.failed': {
        const prev = this.state.get(ev.id) ?? {
          id: ev.id,
          audioPath: ev.id,
          fileName: path.basename(ev.id),
          sizeBytes: 0,
          status: 'running' as const,
        };
        this.state.set(ev.id, {
          ...prev,
          status: 'failed',
          finishedAt: ev.ts,
          durationMs: ev.durationMs,
          ...(ev.error ? { error: ev.error } : {}),
        });
        this.terminalPrunedAt.set(ev.id, this.now());
        break;
      }
    }
    this.pruneExpiredTerminals();
    try {
      this.onChange(this.getSnapshot());
    } catch (err) {
      logger.warn(
        { err, kind: ev.kind, id: ev.id },
        'transcription-service: onChange threw',
      );
    }
  }

  private pruneExpiredTerminals(): void {
    const cutoff = this.now() - this.terminalRetainMs;
    for (const [id, at] of this.terminalPrunedAt) {
      if (at <= cutoff) {
        this.state.delete(id);
        this.terminalPrunedAt.delete(id);
      }
    }
  }
}
