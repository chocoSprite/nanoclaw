import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock db.getAllTasks
const mockGetAllTasks = vi.fn();
vi.mock('./db.js', () => ({
  getAllTasks: (...args: unknown[]) => mockGetAllTasks(...args),
}));

// Mock codex-usage
const mockGetCodexUsageSummary = vi.fn();
vi.mock('./codex-usage.js', () => ({
  getCodexUsageSummary: (...args: unknown[]) =>
    mockGetCodexUsageSummary(...args),
}));

import { buildLabDashboard } from './lab-dashboard.js';
import type { LabDashboardDeps, QueueStatus } from './lab-dashboard.js';
import type { RegisteredGroup } from './types.js';

function makeDeps(overrides: Partial<LabDashboardDeps> = {}): LabDashboardDeps {
  return {
    registeredGroups: {},
    queueStatuses: [],
    sessionCount: 0,
    activeContainerCount: 0,
    timezone: 'Asia/Seoul',
    ...overrides,
  };
}

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'TestGroup',
    folder: 'test_group',
    trigger: '@test',
    added_at: '2026-01-01',
    ...overrides,
  };
}

function makeQueueStatus(overrides: Partial<QueueStatus> = {}): QueueStatus {
  return {
    jid: 'jid1',
    active: false,
    idleWaiting: false,
    isTask: false,
    pendingMessages: false,
    pendingTaskCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllTasks.mockReturnValue([]);
  mockGetCodexUsageSummary.mockResolvedValue(null);
});

describe('buildLabDashboard', () => {
  it('renders header, counts, and usage-failure for empty state', async () => {
    const text = await buildLabDashboard(
      makeDeps({ sessionCount: 5, activeContainerCount: 2 }),
    );

    expect(text).toContain(':bar_chart: *랩 대시보드*');
    expect(text).toContain('*채널* (0개)');
    expect(text).toContain('*컨테이너* 2개 실행 중 | *세션* 5개');
    expect(text).toContain('*Codex 사용량* — 조회 실패');
  });

  it('renders correct icon per queue state (idle/running/task/idle-waiting/main)', async () => {
    const text = await buildLabDashboard(
      makeDeps({
        registeredGroups: {
          jid1: makeGroup({ name: 'Idle', sdk: 'claude' }),
          jid2: makeGroup({ name: 'Running', sdk: 'codex' }),
          jid3: makeGroup({ name: 'Task' }),
          jid4: makeGroup({ name: 'IdleWait' }),
          jid5: makeGroup({ name: 'Main', isMain: true }),
        },
        queueStatuses: [
          makeQueueStatus({ jid: 'jid1' }),
          makeQueueStatus({ jid: 'jid2', active: true }),
          makeQueueStatus({ jid: 'jid3', active: true, isTask: true }),
          makeQueueStatus({ jid: 'jid4', active: true, idleWaiting: true }),
          makeQueueStatus({ jid: 'jid5' }),
        ],
      }),
    );

    expect(text).toContain(':white_circle: *Idle*');
    expect(text).toContain('`Claude`');
    expect(text).toContain(':large_green_circle: *Running*');
    expect(text).toContain('`Codex`');
    expect(text).toContain(':large_orange_circle: *Task*');
    expect(text).toContain(':large_blue_circle: *IdleWait*');
    expect(text).toContain('*Main* :star:');
  });

  it('renders pending messages and tasks suffix', async () => {
    const text = await buildLabDashboard(
      makeDeps({
        registeredGroups: { jid1: makeGroup() },
        queueStatuses: [
          makeQueueStatus({
            jid: 'jid1',
            pendingMessages: true,
            pendingTaskCount: 3,
          }),
        ],
      }),
    );

    expect(text).toContain('메시지 대기, 태스크 3개 대기');
  });

  it('renders Codex usage when available', async () => {
    mockGetCodexUsageSummary.mockResolvedValue({
      h5pct: 40,
      h5reset: '14:00',
      d7pct: 80,
      d7reset: '월요일',
    });

    const text = await buildLabDashboard(makeDeps());

    expect(text).toContain('40%');
    expect(text).toContain('리셋 14:00');
    expect(text).toContain('80%');
    expect(text).not.toContain('조회 실패');
  });

  it('renders scheduled tasks with cron labels', async () => {
    mockGetAllTasks.mockReturnValue([
      {
        id: 't1',
        group_folder: 'slack_news',
        schedule_type: 'cron',
        schedule_value: '0 9 * * 1-5',
        status: 'active',
        next_run: '2026-04-12T09:00:00+09:00',
      },
      {
        id: 't2',
        group_folder: 'slack_report',
        schedule_type: 'interval',
        schedule_value: '30m',
        status: 'paused',
        next_run: null,
      },
    ]);

    const text = await buildLabDashboard(makeDeps());

    expect(text).toContain('활성 1 / 일시정지 1 / 전체 2');
    expect(text).toContain('평일 09:00');
    expect(text).toContain('[slack_news]');
    // Paused task should not appear in upcoming
    expect(text).not.toContain('[slack_report]');
  });
});
