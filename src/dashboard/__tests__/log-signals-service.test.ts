import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _closeDatabase, _initTestDatabase, listSignals } from '../../db.js';
import { InProcessEventBus } from '../../agent-events.js';
import {
  LogSignalsService,
  type LogSignal,
  type SignalChangeStatus,
} from '../services/log-signals-service.js';
import type { LogEntry, LogsService } from '../services/logs-service.js';
import type { SignalsConfig } from '../config.js';

/** Minimal in-memory fake satisfying LogsService.subscribe. */
class FakeLogsService {
  subscribers = new Set<(e: LogEntry) => void>();
  subscribe(cb: (e: LogEntry) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }
  push(entry: LogEntry): void {
    for (const cb of this.subscribers) cb(entry);
  }
}

function cfg(overrides: Partial<SignalsConfig> = {}): SignalsConfig {
  return {
    crashLoopWindowSec: 300,
    crashLoopCount: 3,
    upstreamWindowSec: 120,
    upstreamCount: 5,
    autoResolveHours: 24,
    sweepIntervalMs: 0, // tests drive sweep manually by calling dismiss/now
    ...overrides,
  };
}

function errorEntry(overrides: Partial<LogEntry> & { msg: string }): LogEntry {
  return {
    level: 'error',
    levelNum: 50,
    time: 0,
    msg: overrides.msg,
    group: overrides.group,
    raw: overrides.raw ?? { msg: overrides.msg },
    ...overrides,
  };
}

describe('LogSignalsService', () => {
  let bus: InProcessEventBus;
  let logs: FakeLogsService;
  let changes: Array<{ status: SignalChangeStatus; signal: LogSignal }>;
  let svc: LogSignalsService;
  let nowMs: number;

  function makeService(opts: Partial<SignalsConfig> = {}) {
    const s = new LogSignalsService({
      logs: logs as unknown as LogsService,
      events: bus,
      config: cfg(opts),
      onSignalChange: (status, signal) => changes.push({ status, signal }),
      now: () => nowMs,
    });
    s.start();
    return s;
  }

  beforeEach(() => {
    _initTestDatabase();
    bus = new InProcessEventBus();
    logs = new FakeLogsService();
    changes = [];
    nowMs = Date.parse('2026-04-20T10:00:00.000Z');
    svc = makeService();
  });

  afterEach(() => {
    svc.shutdown();
    _closeDatabase();
  });

  it('oauth_failure upserts on matching entry and bumps count on repeat', () => {
    logs.push(
      errorEntry({
        msg: 'slack auth_test returned 401 Unauthorized',
        group: 'slack_main',
      }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe('active');
    expect(changes[0].signal.kind).toBe('oauth_failure');
    expect(changes[0].signal.groupFolder).toBe('slack_main');
    expect(changes[0].signal.count).toBe(1);

    logs.push(
      errorEntry({
        msg: 'slack auth_test returned 401 Unauthorized',
        group: 'slack_main',
      }),
    );
    expect(changes).toHaveLength(2);
    expect(changes[1].signal.id).toBe(changes[0].signal.id);
    expect(changes[1].signal.count).toBe(2);
    // first_seen preserved, last_seen advanced
    expect(changes[1].signal.firstSeen).toBe(changes[0].signal.firstSeen);
  });

  it('oauth_failure ignores non-error levels and unrelated messages', () => {
    logs.push({ ...errorEntry({ msg: 'ok' }), level: 'info', levelNum: 30 });
    logs.push(errorEntry({ msg: 'timeout after 5000ms' }));
    expect(changes).toHaveLength(0);
  });

  it('crash_loop fires only after crashLoopCount hits within the window', () => {
    const emit = (codeDelayMs: number) => {
      nowMs += codeDelayMs;
      bus.emit({
        v: 1,
        kind: 'container.exited',
        ts: new Date(nowMs).toISOString(),
        groupFolder: 'g',
        exitCode: 1,
      });
    };
    emit(0);
    emit(1_000);
    expect(changes).toHaveLength(0);
    emit(1_000);
    expect(changes).toHaveLength(1);
    expect(changes[0].signal.kind).toBe('crash_loop');
    expect(changes[0].signal.groupFolder).toBe('g');
  });

  it('crash_loop drops exits older than the window', () => {
    // 3 exits but first is out of window
    const fire = (delta: number) => {
      nowMs += delta;
      bus.emit({
        v: 1,
        kind: 'container.exited',
        ts: new Date(nowMs).toISOString(),
        groupFolder: 'g',
        exitCode: 1,
      });
    };
    fire(0); // t=0
    fire(400_000); // t=400s — window is 300s so first shifted out
    fire(10_000); // t=410s — ring now [400s, 410s], 2 entries
    expect(changes).toHaveLength(0);
  });

  it('crash_loop ignores exitCode 0 and null', () => {
    bus.emit({
      v: 1,
      kind: 'container.exited',
      ts: 'now',
      groupFolder: 'g',
      exitCode: 0,
    });
    bus.emit({
      v: 1,
      kind: 'container.exited',
      ts: 'now',
      groupFolder: 'g',
      exitCode: null,
    });
    expect(changes).toHaveLength(0);
  });

  it('upstream_outage aggregates across groups with group_folder=null', () => {
    for (let i = 0; i < 5; i++) {
      logs.push(
        errorEntry({
          msg: 'claude 503 backend overloaded',
          group: i % 2 === 0 ? 'a' : 'b',
          raw: { msg: 'claude 503', provider: 'claude', status: 503 },
        }),
      );
    }
    expect(changes).toHaveLength(1);
    expect(changes[0].signal.kind).toBe('upstream_outage');
    expect(changes[0].signal.groupFolder).toBeNull();
  });

  it('dismiss flips dismissed_at and emits resolved', () => {
    logs.push(errorEntry({ msg: 'slack 401', group: 'slack_main' }));
    const id = changes[0].signal.id;
    changes.length = 0;
    const dismissed = svc.dismiss(id);
    expect(dismissed?.dismissedAt).toBeTruthy();
    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe('resolved');
  });

  it('listActive excludes dismissed rows', () => {
    logs.push(errorEntry({ msg: 'slack 401', group: 'a' }));
    const id = changes[0].signal.id;
    svc.dismiss(id);
    const active = svc.listActive();
    expect(active.find((s) => s.id === id)).toBeUndefined();
  });

  it('subscriber throw does not poison logs stream (isolation)', () => {
    // Replace onSignalChange with one that throws first time.
    changes.length = 0;
    let thrown = false;
    const s2 = new LogSignalsService({
      logs: logs as unknown as LogsService,
      events: bus,
      config: cfg(),
      onSignalChange: (status, signal) => {
        if (!thrown) {
          thrown = true;
          throw new Error('boom');
        }
        changes.push({ status, signal });
      },
      now: () => nowMs,
    });
    s2.start();
    // first push: callback throws — but should be caught
    expect(() => logs.push(errorEntry({ msg: '403 forbidden' }))).not.toThrow();
    // second push still processed; row already exists so bump fires onSignalChange
    logs.push(errorEntry({ msg: '403 forbidden' }));
    expect(changes.length).toBeGreaterThan(0);
    s2.shutdown();
  });

  it('DB partial unique index: two active upserts share one row', () => {
    logs.push(errorEntry({ msg: 'slack 401', group: 'a' }));
    logs.push(errorEntry({ msg: 'slack 401', group: 'a' }));
    const rows = listSignals('active', 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
  });
});
