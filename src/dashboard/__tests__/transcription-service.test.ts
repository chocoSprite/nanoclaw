import { describe, it, expect } from 'vitest';
import {
  InProcessTranscriptionBus,
  type TranscriptionEvent,
} from '../../transcription-events.js';
import {
  TranscriptionService,
  type TranscriptionSnapshot,
} from '../services/transcription-service.js';

function mkEvent<K extends TranscriptionEvent['kind']>(
  kind: K,
  extra: Omit<Extract<TranscriptionEvent, { kind: K }>, 'kind' | 'ts'>,
  ts = '2026-04-20T10:00:00.000Z',
): TranscriptionEvent {
  return { kind, ts, ...extra } as TranscriptionEvent;
}

function makeSvc(now = () => 1_000): {
  svc: TranscriptionService;
  bus: InProcessTranscriptionBus;
  snapshots: TranscriptionSnapshot[];
} {
  const bus = new InProcessTranscriptionBus();
  const snapshots: TranscriptionSnapshot[] = [];
  const svc = new TranscriptionService({
    events: bus,
    onChange: (s) => snapshots.push(s),
    now,
    terminalRetainMs: 5_000,
  });
  svc.start();
  return { svc, bus, snapshots };
}

describe('TranscriptionService', () => {
  it('tracks started → progress → completed and prunes after retain window', () => {
    let clock = 1_000;
    const { svc, bus } = makeSvc(() => clock);

    bus.emit(
      mkEvent('transcription.started', {
        id: '/tmp/a.mp3',
        audioPath: '/tmp/a.mp3',
        sizeBytes: 1_000_000,
      }),
    );
    let snap = svc.getSnapshot();
    expect(snap.active).toHaveLength(1);
    expect(snap.active[0].status).toBe('running');
    expect(snap.active[0].fileName).toBe('a.mp3');

    bus.emit(
      mkEvent('transcription.progress', {
        id: '/tmp/a.mp3',
        stage: 'transcribe',
        t: '00:30',
      }),
    );
    snap = svc.getSnapshot();
    expect(snap.active[0].stage).toBe('transcribe');
    expect(snap.active[0].stageT).toBe('00:30');

    clock = 5_000;
    bus.emit(
      mkEvent('transcription.completed', {
        id: '/tmp/a.mp3',
        outputPath: '/tmp/a.txt',
        durationMs: 4_000,
      }),
    );
    snap = svc.getSnapshot();
    expect(snap.active).toHaveLength(0);
    expect(snap.recentTerminal).toHaveLength(1);
    expect(snap.recentTerminal[0].status).toBe('completed');
    expect(snap.recentTerminal[0].durationMs).toBe(4_000);

    // After retain window the terminal entry is pruned
    clock = 5_000 + 5_001;
    snap = svc.getSnapshot();
    expect(snap.recentTerminal).toHaveLength(0);
  });

  it('queued entries sort by queuePosition and convert to running on started', () => {
    const { svc, bus } = makeSvc();
    bus.emit(
      mkEvent('transcription.queued', {
        id: '/a.mp3',
        audioPath: '/a.mp3',
        sizeBytes: 100,
        queuePosition: 2,
      }),
    );
    bus.emit(
      mkEvent('transcription.queued', {
        id: '/b.mp3',
        audioPath: '/b.mp3',
        sizeBytes: 100,
        queuePosition: 1,
      }),
    );
    let snap = svc.getSnapshot();
    expect(snap.queued.map((e) => e.id)).toEqual(['/b.mp3', '/a.mp3']);

    bus.emit(
      mkEvent('transcription.started', {
        id: '/b.mp3',
        audioPath: '/b.mp3',
        sizeBytes: 100,
      }),
    );
    snap = svc.getSnapshot();
    expect(snap.active.map((e) => e.id)).toEqual(['/b.mp3']);
    expect(snap.queued.map((e) => e.id)).toEqual(['/a.mp3']);
  });

  it('failed without prior started is accepted (defensive)', () => {
    const { svc, bus } = makeSvc();
    bus.emit(
      mkEvent('transcription.failed', {
        id: '/zombie.mp3',
        code: 137,
        error: 'killed',
        durationMs: 1234,
      }),
    );
    const snap = svc.getSnapshot();
    expect(snap.recentTerminal).toHaveLength(1);
    expect(snap.recentTerminal[0].status).toBe('failed');
    expect(snap.recentTerminal[0].error).toBe('killed');
  });

  it('progress for unknown id is dropped (no phantom entry)', () => {
    const { svc, bus } = makeSvc();
    bus.emit(
      mkEvent('transcription.progress', {
        id: '/ghost.mp3',
        stage: 'load',
      }),
    );
    expect(svc.getSnapshot().active).toHaveLength(0);
    expect(svc.getSnapshot().queued).toHaveLength(0);
  });

  it('calls onChange on every state mutation', () => {
    const { bus, snapshots } = makeSvc();
    bus.emit(
      mkEvent('transcription.started', {
        id: '/a.mp3',
        audioPath: '/a.mp3',
        sizeBytes: 100,
      }),
    );
    bus.emit(
      mkEvent('transcription.progress', {
        id: '/a.mp3',
        stage: 'load',
      }),
    );
    expect(snapshots.length).toBe(2);
  });

  it('stop() unsubscribes from the bus', () => {
    const { svc, bus, snapshots } = makeSvc();
    svc.stop();
    bus.emit(
      mkEvent('transcription.started', {
        id: '/a.mp3',
        audioPath: '/a.mp3',
        sizeBytes: 100,
      }),
    );
    expect(snapshots).toHaveLength(0);
  });
});
