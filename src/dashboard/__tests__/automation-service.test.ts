import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _closeDatabase,
  _initTestDatabase,
  createTask,
  getTaskById,
  logTaskRun,
} from '../../db.js';
import { AutomationService } from '../services/automation-service.js';
import type { ScheduledTask } from '../../types.js';

function makeTask(
  id: string,
  overrides: Partial<ScheduledTask> = {},
): Omit<ScheduledTask, 'last_run' | 'last_result'> {
  return {
    id,
    group_folder: 'g1',
    chat_jid: 'slack:C1',
    prompt: 'do the thing',
    script: null,
    schedule_type: 'cron',
    schedule_value: '0 * * * *',
    context_mode: 'isolated',
    next_run: '2030-01-01T00:00:00.000Z',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('AutomationService', () => {
  let onTasksChanged: ReturnType<typeof vi.fn>;
  let service: AutomationService;

  beforeEach(() => {
    _initTestDatabase();
    onTasksChanged = vi.fn();
    service = new AutomationService({ onTasksChanged });
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('listTasks returns all registered tasks', () => {
    createTask(makeTask('a'));
    createTask(makeTask('b', { group_folder: 'g2' }));
    const tasks = service.listTasks();
    expect(tasks.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('pauseTask flips status to paused + fires onTasksChanged', () => {
    createTask(makeTask('a'));
    const updated = service.pauseTask('a');
    expect(updated?.status).toBe('paused');
    expect(onTasksChanged).toHaveBeenCalledTimes(1);
  });

  it('pauseTask on missing id returns undefined + no mutation signal', () => {
    const out = service.pauseTask('missing');
    expect(out).toBeUndefined();
    expect(onTasksChanged).not.toHaveBeenCalled();
  });

  it('resumeTask flips paused back to active', () => {
    createTask(makeTask('a', { status: 'paused' }));
    const updated = service.resumeTask('a');
    expect(updated?.status).toBe('active');
    expect(onTasksChanged).toHaveBeenCalledOnce();
  });

  it('triggerNow sets next_run to roughly now and status to active', () => {
    createTask(
      makeTask('a', {
        status: 'paused',
        next_run: '2030-01-01T00:00:00.000Z',
      }),
    );
    const before = Date.now();
    const updated = service.triggerNow('a');
    const after = Date.now();
    expect(updated?.status).toBe('active');
    expect(updated?.next_run).toBeTruthy();
    const nextRunMs = Date.parse(updated!.next_run!);
    expect(nextRunMs).toBeGreaterThanOrEqual(before);
    expect(nextRunMs).toBeLessThanOrEqual(after);
  });

  it('deleteTask removes row + cascades to task_run_logs', () => {
    createTask(makeTask('a'));
    logTaskRun({
      task_id: 'a',
      run_at: '2026-04-20T00:00:00.000Z',
      duration_ms: 500,
      status: 'success',
      result: 'ok',
      error: null,
    });
    const runsBefore = service.getTaskRuns('a');
    expect(runsBefore).toHaveLength(1);
    const ok = service.deleteTask('a');
    expect(ok).toBe(true);
    expect(getTaskById('a')).toBeUndefined();
    expect(service.getTaskRuns('a')).toHaveLength(0);
  });

  it('deleteTask on missing id returns false + no mutation signal', () => {
    const ok = service.deleteTask('missing');
    expect(ok).toBe(false);
    expect(onTasksChanged).not.toHaveBeenCalled();
  });

  it('getTaskRuns respects DESC order + limit', () => {
    createTask(makeTask('a'));
    for (let i = 0; i < 5; i++) {
      logTaskRun({
        task_id: 'a',
        run_at: `2026-04-2${i}T00:00:00.000Z`,
        duration_ms: 100 * (i + 1),
        status: 'success',
        result: `run-${i}`,
        error: null,
      });
    }
    const runs = service.getTaskRuns('a', 3);
    expect(runs).toHaveLength(3);
    // DESC — newest first
    expect(runs[0].run_at).toBe('2026-04-24T00:00:00.000Z');
    expect(runs[2].run_at).toBe('2026-04-22T00:00:00.000Z');
  });
});
