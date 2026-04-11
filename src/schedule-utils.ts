import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';
import { logger } from './logger.js';
import { ScheduledTask } from './types.js';

/**
 * Compute the initial next_run for a new or updated task.
 * Throws on invalid input so the caller can decide how to handle it.
 */
export function computeInitialNextRun(
  type: 'cron' | 'interval' | 'once',
  value: string,
): string {
  if (type === 'cron') {
    const interval = CronExpressionParser.parse(value, { tz: TIMEZONE });
    return interval.next().toISOString()!;
  }

  if (type === 'interval') {
    const ms = parseInt(value, 10);
    if (isNaN(ms) || ms <= 0) {
      throw new Error(`Invalid interval value: ${value}`);
    }
    return new Date(Date.now() + ms).toISOString();
  }

  // once
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return date.toISOString();
}

/**
 * Compute the next run time for a recurring task after execution,
 * anchored to the task's scheduled time rather than Date.now() to
 * prevent cumulative drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString()!;
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}
