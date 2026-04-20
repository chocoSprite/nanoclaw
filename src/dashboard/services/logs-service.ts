/**
 * Logs service — exposes the host's JSON log stream (pino-compatible lines
 * written to `logs/nanoclaw.log` / `logs/nanoclaw.error.log`) over the
 * dashboard REST + WS surface.
 *
 * Two capabilities:
 *  - readRecent(filter): historical — reverse-tail the file, parse, filter,
 *    return newest-first up to `limit`.
 *  - openStream(onEntry): live — watch the file(s) with chokidar and push
 *    each newly-appended JSON line to the subscriber.
 *
 * Lines that fail JSON.parse are skipped silently. Pre-transition pretty
 * logs will not parse — the dashboard therefore only shows entries written
 * after the logger JSON switch landed.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../logger.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_NUM: Record<LogLevel, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface LogEntry {
  level: LogLevel;
  levelNum: number;
  time: number; // unix ms
  pid?: number;
  msg: string;
  group?: string; // derived from group_folder / groupFolder / group keys
  raw: Record<string, unknown>;
}

export interface LogFilter {
  level?: LogLevel; // min level
  group?: string;
  search?: string;
}

export interface LogsServiceOptions {
  logsDir: string;
  /** Default: logs/nanoclaw.log + logs/nanoclaw.error.log */
  files?: string[];
}

function levelStringFromNumber(n: number): LogLevel {
  if (n >= LEVEL_NUM.fatal) return 'fatal';
  if (n >= LEVEL_NUM.error) return 'error';
  if (n >= LEVEL_NUM.warn) return 'warn';
  if (n >= LEVEL_NUM.info) return 'info';
  return 'debug';
}

function extractGroup(raw: Record<string, unknown>): string | undefined {
  for (const key of ['group_folder', 'groupFolder', 'group']) {
    const v = raw[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function parseLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const levelNum = typeof obj.level === 'number' ? obj.level : 30;
  const time =
    typeof obj.time === 'number' ? obj.time : Date.parse(String(obj.time));
  const msg = typeof obj.msg === 'string' ? obj.msg : '';
  return {
    level: levelStringFromNumber(levelNum),
    levelNum,
    time: Number.isFinite(time) ? time : Date.now(),
    pid: typeof obj.pid === 'number' ? obj.pid : undefined,
    msg,
    group: extractGroup(obj),
    raw: obj,
  };
}

function passesFilter(entry: LogEntry, filter: LogFilter): boolean {
  if (filter.level) {
    const min = LEVEL_NUM[filter.level];
    if (entry.levelNum < min) return false;
  }
  if (filter.group && entry.group !== filter.group) return false;
  if (filter.search) {
    const q = filter.search.toLowerCase();
    if (
      !entry.msg.toLowerCase().includes(q) &&
      !JSON.stringify(entry.raw).toLowerCase().includes(q)
    ) {
      return false;
    }
  }
  return true;
}

const REVERSE_CHUNK_BYTES = 64 * 1024;

/**
 * Read the last `limit` entries (newest-first) that pass the filter.
 * Reads the file in reverse 64KB chunks to avoid loading multi-MB logs
 * entirely into memory. Bounded — gives up after scanning 10 MB.
 */
export async function readRecentFromFile(
  filePath: string,
  filter: LogFilter,
  limit: number,
): Promise<LogEntry[]> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return [];
  }
  const out: LogEntry[] = [];
  const fd = await fs.promises.open(filePath, 'r');
  try {
    let pos = stat.size;
    let leftover = '';
    const MAX_SCAN = 10 * 1024 * 1024;
    let scanned = 0;
    while (pos > 0 && out.length < limit && scanned < MAX_SCAN) {
      const chunkSize = Math.min(REVERSE_CHUNK_BYTES, pos);
      pos -= chunkSize;
      scanned += chunkSize;
      const buf = Buffer.alloc(chunkSize);
      await fd.read(buf, 0, chunkSize, pos);
      const chunk = buf.toString('utf8') + leftover;
      const lines = chunk.split('\n');
      // The first split segment may be partial (its start was chopped by the
      // previous read boundary) — stash it for the next iteration unless
      // we're at BOF.
      leftover = pos === 0 ? '' : (lines.shift() ?? '');
      // Walk newest (last) → oldest (first) within this chunk.
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = parseLine(lines[i]);
        if (entry && passesFilter(entry, filter)) {
          out.push(entry);
          if (out.length >= limit) break;
        }
      }
    }
    if (leftover && out.length < limit) {
      const entry = parseLine(leftover);
      if (entry && passesFilter(entry, filter)) out.push(entry);
    }
  } finally {
    await fd.close();
  }
  return out;
}

export class LogsService {
  private readonly files: string[];
  private watcher: FSWatcher | null = null;
  private readonly subscribers = new Set<(e: LogEntry) => void>();
  private readonly tailOffsets = new Map<string, number>();

  constructor(private readonly opts: LogsServiceOptions) {
    this.files = opts.files ?? [
      path.join(opts.logsDir, 'nanoclaw.log'),
      path.join(opts.logsDir, 'nanoclaw.error.log'),
    ];
  }

  async readRecent(
    filter: LogFilter,
    limit: number = 200,
  ): Promise<LogEntry[]> {
    const perFile = await Promise.all(
      this.files.map((f) => readRecentFromFile(f, filter, limit)),
    );
    // Merge then sort by time DESC and trim.
    const merged = perFile.flat();
    merged.sort((a, b) => b.time - a.time);
    return merged.slice(0, limit);
  }

  subscribe(cb: (entry: LogEntry) => void): () => void {
    this.subscribers.add(cb);
    // Lazy start the watcher on first subscriber to avoid FS handles when
    // nobody is listening.
    if (this.subscribers.size === 1) this.start();
    return () => {
      this.subscribers.delete(cb);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  private start(): void {
    for (const f of this.files) {
      try {
        this.tailOffsets.set(f, fs.statSync(f).size);
      } catch {
        this.tailOffsets.set(f, 0);
      }
    }
    this.watcher = chokidar.watch(this.files, {
      awaitWriteFinish: false,
      ignoreInitial: true,
      persistent: true,
      atomic: false,
    });
    this.watcher.on('change', (file) => {
      void this.onFileChange(file);
    });
    // inode change (rotation) — chokidar emits 'unlink' + 'add'
    this.watcher.on('add', (file) => {
      this.tailOffsets.set(file, 0);
      void this.onFileChange(file);
    });
    this.watcher.on('error', (err) => {
      logger.warn({ scope: 'dashboard', err }, 'logs-service watcher error');
    });
  }

  private async onFileChange(file: string): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return;
    }
    let from = this.tailOffsets.get(file) ?? 0;
    // Truncation (rotate-in-place) — restart from 0.
    if (stat.size < from) from = 0;
    if (stat.size === from) return;

    const fd = await fs.promises.open(file, 'r');
    try {
      const size = stat.size - from;
      const buf = Buffer.alloc(size);
      await fd.read(buf, 0, size, from);
      this.tailOffsets.set(file, stat.size);
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      for (const line of lines) {
        const entry = parseLine(line);
        if (!entry) continue;
        for (const cb of this.subscribers) {
          try {
            cb(entry);
          } catch (err) {
            logger.warn(
              { scope: 'dashboard', err },
              'log subscriber threw, continuing',
            );
          }
        }
      }
    } finally {
      await fd.close();
    }
  }

  private stop(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
    this.tailOffsets.clear();
  }

  async shutdown(): Promise<void> {
    this.subscribers.clear();
    this.stop();
  }
}
