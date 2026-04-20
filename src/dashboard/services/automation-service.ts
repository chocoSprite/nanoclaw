/**
 * Dashboard Automation service — wraps DB + IPC-equivalent mutation logic so
 * REST handlers remain thin. Mutations rewrite the per-group task snapshot so
 * containers (agents) see fresh state without waiting for scheduler poll.
 *
 * Authorization: dashboard requests are trusted (Tailscale-only, no auth layer
 * yet). IPC's `canMutateTask` check is intentionally not replicated here —
 * dashboard-originated actions are equivalent to "main group" privilege.
 */

import {
  deleteTask as dbDeleteTask,
  getAllTasks,
  getTaskById,
  getTaskRunHistory,
  updateTask,
} from '../../db.js';
import type { ScheduledTask, TaskRunLog } from '../../types.js';

export interface AutomationServiceDeps {
  onTasksChanged: () => void;
}

export class AutomationService {
  constructor(private readonly deps: AutomationServiceDeps) {}

  listTasks(): ScheduledTask[] {
    return getAllTasks();
  }

  getTaskRuns(taskId: string, limit: number = 10): TaskRunLog[] {
    return getTaskRunHistory(taskId, limit);
  }

  /** Returns the affected task (post-update) or undefined if not found. */
  pauseTask(taskId: string): ScheduledTask | undefined {
    const task = getTaskById(taskId);
    if (!task) return undefined;
    updateTask(taskId, { status: 'paused' });
    this.deps.onTasksChanged();
    return getTaskById(taskId);
  }

  resumeTask(taskId: string): ScheduledTask | undefined {
    const task = getTaskById(taskId);
    if (!task) return undefined;
    updateTask(taskId, { status: 'active' });
    this.deps.onTasksChanged();
    return getTaskById(taskId);
  }

  /**
   * Set next_run to now so the scheduler poll (within SCHEDULER_POLL_INTERVAL)
   * picks it up. Requires the task to be 'active' — otherwise the poller skips.
   * Returns the affected task or undefined if not found.
   */
  triggerNow(taskId: string): ScheduledTask | undefined {
    const task = getTaskById(taskId);
    if (!task) return undefined;
    updateTask(taskId, {
      next_run: new Date().toISOString(),
      status: 'active',
    });
    this.deps.onTasksChanged();
    return getTaskById(taskId);
  }

  /** Returns true on delete, false if task did not exist. */
  deleteTask(taskId: string): boolean {
    const task = getTaskById(taskId);
    if (!task) return false;
    dbDeleteTask(taskId);
    this.deps.onTasksChanged();
    return true;
  }
}
