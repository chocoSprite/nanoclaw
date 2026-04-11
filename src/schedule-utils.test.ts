import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeInitialNextRun, computeNextRun } from './schedule-utils.js';

describe('computeInitialNextRun', () => {
  it('computes next cron run', () => {
    const result = computeInitialNextRun('cron', '0 9 * * *');
    expect(new Date(result).getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('throws on invalid cron expression', () => {
    expect(() => computeInitialNextRun('cron', 'not-a-cron')).toThrow();
  });

  it('computes interval from now', () => {
    const before = Date.now();
    const result = computeInitialNextRun('interval', '60000');
    const after = Date.now();
    const resultMs = new Date(result).getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before + 60000);
    expect(resultMs).toBeLessThanOrEqual(after + 60000);
  });

  it('throws on invalid interval', () => {
    expect(() => computeInitialNextRun('interval', 'abc')).toThrow(
      'Invalid interval',
    );
    expect(() => computeInitialNextRun('interval', '0')).toThrow(
      'Invalid interval',
    );
    expect(() => computeInitialNextRun('interval', '-100')).toThrow(
      'Invalid interval',
    );
  });

  it('returns once timestamp as-is', () => {
    const ts = '2030-06-15T12:00:00.000Z';
    const result = computeInitialNextRun('once', ts);
    expect(result).toBe(ts);
  });

  it('throws on invalid once timestamp', () => {
    expect(() => computeInitialNextRun('once', 'not-a-date')).toThrow(
      'Invalid timestamp',
    );
  });
});

describe('computeNextRun', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for once tasks', () => {
    expect(
      computeNextRun({
        id: 't1',
        group_folder: 'g',
        chat_jid: 'j',
        prompt: 'p',
        schedule_type: 'once',
        schedule_value: '2030-01-01T00:00:00.000Z',
        context_mode: 'isolated',
        next_run: '2030-01-01T00:00:00.000Z',
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('anchors interval to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString();
    const nextRun = computeNextRun({
      id: 't2',
      group_folder: 'g',
      chat_jid: 'j',
      prompt: 'p',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(nextRun).not.toBeNull();
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('skips missed intervals to land in the future', () => {
    const ms = 60000;
    const scheduledTime = new Date(Date.now() - ms * 10).toISOString();
    const nextRun = computeNextRun({
      id: 't3',
      group_folder: 'g',
      chat_jid: 'j',
      prompt: 'p',
      schedule_type: 'interval',
      schedule_value: String(ms),
      context_mode: 'isolated',
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('falls back to 60s for invalid interval', () => {
    const nextRun = computeNextRun({
      id: 't4',
      group_folder: 'g',
      chat_jid: 'j',
      prompt: 'p',
      schedule_type: 'interval',
      schedule_value: 'bad',
      context_mode: 'isolated',
      next_run: new Date().toISOString(),
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(nextRun).not.toBeNull();
    const diff = new Date(nextRun!).getTime() - Date.now();
    expect(diff).toBeGreaterThanOrEqual(59000);
    expect(diff).toBeLessThanOrEqual(61000);
  });
});
