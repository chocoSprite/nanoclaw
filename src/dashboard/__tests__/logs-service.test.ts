import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LogsService, readRecentFromFile } from '../services/logs-service.js';

function lineFor(
  level: number,
  msg: string,
  extra: Record<string, unknown> = {},
) {
  return (
    JSON.stringify({
      level,
      time:
        Date.parse('2026-04-20T00:00:00.000Z') + ((extra._t as number) ?? 0),
      pid: 12345,
      msg,
      ...extra,
    }) + '\n'
  );
}

describe('readRecentFromFile', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-test-'));
    file = path.join(dir, 'nanoclaw.log');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty when file missing', async () => {
    const out = await readRecentFromFile(path.join(dir, 'missing.log'), {}, 10);
    expect(out).toEqual([]);
  });

  it('reads newest-first up to limit', async () => {
    let content = '';
    for (let i = 0; i < 5; i++) {
      content += lineFor(30, `msg-${i}`, { _t: i * 1000 });
    }
    fs.writeFileSync(file, content);
    const out = await readRecentFromFile(file, {}, 3);
    expect(out.map((e) => e.msg)).toEqual(['msg-4', 'msg-3', 'msg-2']);
  });

  it('filters by level (minimum inclusive)', async () => {
    const content =
      lineFor(20, 'dbg') +
      lineFor(30, 'inf') +
      lineFor(40, 'wrn') +
      lineFor(50, 'err');
    fs.writeFileSync(file, content);
    const out = await readRecentFromFile(file, { level: 'warn' }, 10);
    expect(out.map((e) => e.msg)).toEqual(['err', 'wrn']);
  });

  it('filters by group (exact match)', async () => {
    const content =
      lineFor(30, 'a', { group_folder: 'g1' }) +
      lineFor(30, 'b', { group_folder: 'g2' }) +
      lineFor(30, 'c', { groupFolder: 'g1' });
    fs.writeFileSync(file, content);
    const out = await readRecentFromFile(file, { group: 'g1' }, 10);
    expect(out.map((e) => e.msg).sort()).toEqual(['a', 'c']);
  });

  it('filters by search (case insensitive, msg + raw)', async () => {
    const content =
      lineFor(30, 'task scheduled for retry') +
      lineFor(30, 'ordinary msg', { reason: 'Retry Triggered' });
    fs.writeFileSync(file, content);
    const out = await readRecentFromFile(file, { search: 'retry' }, 10);
    expect(out).toHaveLength(2);
  });

  it('skips malformed JSON lines without failing', async () => {
    const content =
      'not json\n' +
      lineFor(30, 'ok') +
      'also garbage\n' +
      lineFor(30, 'second');
    fs.writeFileSync(file, content);
    const out = await readRecentFromFile(file, {}, 10);
    expect(out.map((e) => e.msg)).toEqual(['second', 'ok']);
  });

  it('handles a line spanning a read chunk boundary', async () => {
    // Build a line whose JSON is bigger than the 64KB reverse chunk.
    const bigMsg = 'x'.repeat(80_000);
    fs.writeFileSync(file, lineFor(30, 'pre') + lineFor(30, bigMsg));
    const out = await readRecentFromFile(file, {}, 10);
    expect(out.map((e) => e.msg)).toEqual([bigMsg, 'pre']);
  });
});

describe('LogsService.subscribe', () => {
  let dir: string;
  let service: LogsService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-test-svc-'));
    fs.writeFileSync(path.join(dir, 'nanoclaw.log'), '');
    fs.writeFileSync(path.join(dir, 'nanoclaw.error.log'), '');
    service = new LogsService({ logsDir: dir });
  });

  afterEach(async () => {
    await service.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('invokes callback on appended lines', async () => {
    const received: string[] = [];
    service.subscribe((e) => {
      received.push(e.msg);
    });
    // chokidar needs a tick to arm the watcher
    await new Promise((r) => setTimeout(r, 100));
    fs.appendFileSync(path.join(dir, 'nanoclaw.log'), lineFor(30, 'hello'));
    // Wait for filesystem event + handler
    for (let i = 0; i < 20 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(received).toContain('hello');
  });
});
