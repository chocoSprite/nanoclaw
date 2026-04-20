/**
 * Host-level transcription event bus — mirror of `src/agent-events.ts` but
 * for WhisperX jobs. Transcription is a host subprocess (not a container)
 * and has no groupFolder/chatJid, so it can't be expressed on the
 * AgentEventV1 union without abusing those fields.
 *
 * Lifecycle:
 *   queued → running → (completed | failed)
 *   running → (completed | failed)   // when lock acquired immediately
 *
 * `id` is the full audioPath — unique per file since WhisperX writes its
 * output next to the input, and duplicate in-flight calls for the same
 * path are blocked by the existing mutex in transcribe.ts.
 */

export interface TranscriptionQueuedEvent {
  kind: 'transcription.queued';
  id: string;
  audioPath: string;
  sizeBytes: number;
  queuePosition: number;
  ts: string;
}

export interface TranscriptionStartedEvent {
  kind: 'transcription.started';
  id: string;
  audioPath: string;
  sizeBytes: number;
  ts: string;
}

export interface TranscriptionProgressEvent {
  kind: 'transcription.progress';
  id: string;
  stage: string; // load | transcribe | align | diarize | error
  t?: string; // optional MM:SS position within the audio
  ts: string;
}

export interface TranscriptionCompletedEvent {
  kind: 'transcription.completed';
  id: string;
  outputPath: string;
  durationMs: number;
  ts: string;
}

export interface TranscriptionFailedEvent {
  kind: 'transcription.failed';
  id: string;
  code: number | null;
  error?: string;
  durationMs: number;
  ts: string;
}

export type TranscriptionEvent =
  | TranscriptionQueuedEvent
  | TranscriptionStartedEvent
  | TranscriptionProgressEvent
  | TranscriptionCompletedEvent
  | TranscriptionFailedEvent;

export type TranscriptionEventKind = TranscriptionEvent['kind'];

type Listener<K extends TranscriptionEventKind | '*'> = K extends '*'
  ? (ev: TranscriptionEvent) => void
  : (ev: Extract<TranscriptionEvent, { kind: K }>) => void;

export interface TranscriptionEventBus {
  emit(ev: TranscriptionEvent): void;
  on<K extends TranscriptionEventKind | '*'>(
    kind: K,
    fn: Listener<K>,
  ): () => void;
}

/**
 * Single-process bus. Listener faults are swallowed so a bad subscriber
 * can't break the transcribe pipeline (same isolation pattern as
 * agent-events).
 */
export class InProcessTranscriptionBus implements TranscriptionEventBus {
  private readonly listeners = new Map<
    TranscriptionEventKind | '*',
    Set<(ev: TranscriptionEvent) => void>
  >();

  emit(ev: TranscriptionEvent): void {
    this.dispatch(ev.kind, ev);
    this.dispatch('*', ev);
  }

  on<K extends TranscriptionEventKind | '*'>(
    kind: K,
    fn: Listener<K>,
  ): () => void {
    const bucket = this.listeners.get(kind) ?? new Set();
    const wrapped = fn as (ev: TranscriptionEvent) => void;
    bucket.add(wrapped);
    this.listeners.set(kind, bucket);
    return () => {
      const current = this.listeners.get(kind);
      if (!current) return;
      current.delete(wrapped);
      if (current.size === 0) this.listeners.delete(kind);
    };
  }

  listenerCount(kind?: TranscriptionEventKind | '*'): number {
    if (kind) return this.listeners.get(kind)?.size ?? 0;
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  private dispatch(
    kind: TranscriptionEventKind | '*',
    ev: TranscriptionEvent,
  ): void {
    const bucket = this.listeners.get(kind);
    if (!bucket) return;
    for (const fn of bucket) {
      try {
        fn(ev);
      } catch (err) {
        process.stderr.write(
          `[transcription-events] listener threw for kind=${kind}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }
}

export const transcriptionEvents: TranscriptionEventBus =
  new InProcessTranscriptionBus();
