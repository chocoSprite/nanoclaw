import { describe, it, expect } from 'vitest';
import { GroupsService } from '../services/groups-service.js';
import { LiveStateCache } from '../live-state.js';
import { InProcessEventBus, type AgentEventV1 } from '../../agent-events.js';
import type {
  RegisteredGroupEntry,
  StateReader,
} from '../adapters/state-adapter.js';
import type { QueueReader, QueueStatus } from '../adapters/queue-adapter.js';
import type { RegisteredGroup } from '../../types.js';

function group(
  folder: string,
  overrides: Partial<RegisteredGroup> = {},
): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '@bot',
    added_at: '2026-04-19',
    sdk: 'claude',
    ...overrides,
  };
}

class FakeStateReader implements StateReader {
  constructor(private readonly entries: RegisteredGroupEntry[]) {}
  listRegisteredGroups(): RegisteredGroupEntry[] {
    return this.entries;
  }
}

class FakeQueueReader implements QueueReader {
  constructor(private readonly statuses: QueueStatus[]) {}
  getStatuses(): QueueStatus[] {
    return this.statuses;
  }
}

function emptyQueueStatus(jid: string, active = false): QueueStatus {
  return {
    jid,
    active,
    idleWaiting: false,
    isTask: false,
    pendingMessages: false,
    pendingSinceTs: null,
    pendingTaskCount: 0,
    runningTaskId: null,
  };
}

function toolUse(jid: string, toolName: string): AgentEventV1 {
  return {
    v: 1,
    kind: 'tool.use',
    ts: '2026-04-19T01:02:03.000Z',
    groupFolder: 'g',
    chatJid: jid,
    toolName,
  };
}

function statusEnded(jid: string): AgentEventV1 {
  return {
    v: 1,
    kind: 'status.ended',
    ts: '2026-04-19T01:02:04.000Z',
    groupFolder: 'g',
    chatJid: jid,
    outcome: 'success',
  };
}

describe('GroupsService', () => {
  it('lists every registered group as idle when no events observed', () => {
    const state = new FakeStateReader([
      { jid: 'slack:A', group: group('alpha') },
      { jid: 'slack:B', group: group('bravo', { sdk: 'codex' }) },
    ]);
    const queue = new FakeQueueReader([]);
    const live = new LiveStateCache();
    const svc = new GroupsService(state, queue, live);

    const out = svc.listLive();
    expect(out).toHaveLength(2);
    expect(out.map((g) => g.containerStatus)).toEqual(['idle', 'idle']);
    expect(out.map((g) => g.currentTool)).toEqual([null, null]);
    expect(out.map((g) => g.sdk)).toEqual(['claude', 'codex']);
  });

  it('falls back to queue.active when no live event yet', () => {
    const state = new FakeStateReader([
      { jid: 'slack:A', group: group('alpha') },
    ]);
    const queue = new FakeQueueReader([emptyQueueStatus('slack:A', true)]);
    const live = new LiveStateCache();
    const svc = new GroupsService(state, queue, live);

    const [g] = svc.listLive();
    expect(g.containerStatus).toBe('running');
    expect(g.currentTool).toBeNull();
  });

  it('tool.use updates currentTool for the matching jid only', () => {
    const state = new FakeStateReader([
      { jid: 'slack:A', group: group('alpha') },
      { jid: 'slack:B', group: group('bravo') },
    ]);
    const queue = new FakeQueueReader([]);
    const live = new LiveStateCache();
    const bus = new InProcessEventBus();
    live.subscribe(bus);
    const svc = new GroupsService(state, queue, live);

    bus.emit(toolUse('slack:A', 'Read'));
    const out = svc.listLive();
    const byJid = Object.fromEntries(out.map((g) => [g.jid, g]));
    expect(byJid['slack:A'].currentTool).toBe('Read');
    expect(byJid['slack:A'].containerStatus).toBe('idle'); // no status.started yet
    expect(byJid['slack:B'].currentTool).toBeNull();
  });

  it('status.ended clears currentTool and returns to idle', () => {
    const state = new FakeStateReader([
      { jid: 'slack:A', group: group('alpha') },
    ]);
    const queue = new FakeQueueReader([]);
    const live = new LiveStateCache();
    const bus = new InProcessEventBus();
    live.subscribe(bus);
    const svc = new GroupsService(state, queue, live);

    bus.emit({
      v: 1,
      kind: 'status.started',
      ts: 'now',
      groupFolder: 'alpha',
      chatJid: 'slack:A',
      sdk: 'claude',
    });
    bus.emit(toolUse('slack:A', 'Read'));
    expect(svc.listLive()[0].containerStatus).toBe('running');
    expect(svc.listLive()[0].currentTool).toBe('Read');

    bus.emit(statusEnded('slack:A'));
    const after = svc.listLive()[0];
    expect(after.containerStatus).toBe('idle');
    expect(after.currentTool).toBeNull();
  });

  it('status.ended with outcome=error sets containerStatus=error', () => {
    const state = new FakeStateReader([
      { jid: 'slack:A', group: group('alpha') },
    ]);
    const queue = new FakeQueueReader([]);
    const live = new LiveStateCache();
    const bus = new InProcessEventBus();
    live.subscribe(bus);
    const svc = new GroupsService(state, queue, live);

    bus.emit({
      v: 1,
      kind: 'status.ended',
      ts: 'now',
      groupFolder: 'alpha',
      chatJid: 'slack:A',
      outcome: 'error',
      error: 'boom',
    });
    expect(svc.listLive()[0].containerStatus).toBe('error');
  });

  it('container.exited with non-zero code sets error (status.ended missing)', () => {
    const state = new FakeStateReader([
      { jid: 'slack:A', group: group('alpha', { sdk: 'codex' }) },
    ]);
    const queue = new FakeQueueReader([]);
    const live = new LiveStateCache();
    const bus = new InProcessEventBus();
    live.subscribe(bus);
    const svc = new GroupsService(state, queue, live);

    bus.emit({
      v: 1,
      kind: 'container.exited',
      ts: 'now',
      groupFolder: 'alpha',
      chatJid: 'slack:A',
      exitCode: 1,
    });
    expect(svc.listLive()[0].containerStatus).toBe('error');
  });

  it('pendingSinceTs passes through from queue (null when no pending)', () => {
    const state = new FakeStateReader([
      { jid: 'slack:A', group: group('alpha') },
    ]);
    const queue = new FakeQueueReader([emptyQueueStatus('slack:A', true)]);
    const svc = new GroupsService(state, queue, new LiveStateCache());
    expect(svc.listLive()[0].pendingSinceTs).toBeNull();
  });

  it('pendingSinceTs passes through from queue when set', () => {
    const state = new FakeStateReader([
      { jid: 'slack:A', group: group('alpha') },
    ]);
    const ts = Date.now() - 90_000;
    const queue = new FakeQueueReader([
      {
        ...emptyQueueStatus('slack:A', true),
        pendingMessages: true,
        pendingSinceTs: ts,
      },
    ]);
    const svc = new GroupsService(state, queue, new LiveStateCache());
    expect(svc.listLive()[0].pendingSinceTs).toBe(ts);
  });

  it('listRoster flags queue.active accurately', () => {
    const state = new FakeStateReader([
      { jid: 'slack:A', group: group('alpha') },
      { jid: 'slack:B', group: group('bravo') },
    ]);
    const queue = new FakeQueueReader([emptyQueueStatus('slack:A', true)]);
    const live = new LiveStateCache();
    const svc = new GroupsService(state, queue, live);

    const roster = svc.listRoster();
    expect(roster.find((r) => r.jid === 'slack:A')?.active).toBe(true);
    expect(roster.find((r) => r.jid === 'slack:B')?.active).toBe(false);
  });
});
