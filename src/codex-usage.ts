import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

export interface CodexRateLimit {
  limitId: string;
  limitName: string | null;
  primary: { usedPercent: number; resetsAt: string | number };
  secondary: { usedPercent: number; resetsAt: string | number };
}

export interface CodexUsageSummary {
  h5pct: number; // 5-hour usage percent (0-100), -1 = unknown
  h5reset: string; // human-readable reset time
  d7pct: number; // 7-day usage percent (0-100), -1 = unknown
  d7reset: string; // human-readable reset time
}

/**
 * Spawn `codex app-server`, send JSON-RPC to fetch rate limits, then kill it.
 * Returns null on any failure (timeout, missing binary, parse error).
 */
export async function fetchCodexUsage(): Promise<CodexRateLimit[] | null> {
  const codexBin = resolveCodexBin();

  return new Promise((resolve) => {
    let done = false;
    let proc: ChildProcess | null = null;

    const finish = (value: CodexRateLimit[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc?.kill();
      } catch {
        /* ignore */
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), 15_000);

    const spawnEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: [
        path.dirname(process.execPath),
        path.join(os.homedir(), '.npm-global', 'bin'),
        process.env.PATH || '',
      ].join(':'),
    };

    try {
      proc = spawn(codexBin, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
      });
    } catch {
      resolve(null);
      return;
    }

    if (!proc.stdout || !proc.stdin) {
      finish(null);
      return;
    }

    proc.on('error', () => finish(null));
    proc.on('close', () => finish(null));

    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            // Initialize succeeded, now request rate limits
            proc!.stdin!.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'account/rateLimits/read',
                params: {},
              }) + '\n',
            );
          } else if (message.id === 2 && message.result) {
            const byId = message.result.rateLimitsByLimitId;
            finish(
              byId && typeof byId === 'object'
                ? Object.entries(byId).map(([id, val]) => ({
                    ...(val as CodexRateLimit),
                    limitId: id,
                  }))
                : null,
            );
          }
        } catch {
          /* ignore parse errors */
        }
      }
    });

    // Send initialize request
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'nanoclaw-usage', version: '1.0' } },
      }) + '\n',
    );
  });
}

/**
 * High-level: fetch Codex usage and return a simple summary.
 * Returns null if usage cannot be retrieved.
 */
export async function getCodexUsageSummary(): Promise<CodexUsageSummary | null> {
  try {
    const limits = await fetchCodexUsage();
    if (!limits || limits.length === 0) return null;

    // Prefer the 'codex' bucket; fall back to single bucket
    const bucket =
      limits.find((l) => l.limitId === 'codex') ??
      (limits.length === 1 ? limits[0] : null);
    if (!bucket) return null;

    return {
      h5pct: Math.round(bucket.primary.usedPercent),
      h5reset: formatResetTime(bucket.primary.resetsAt),
      d7pct: Math.round(bucket.secondary.usedPercent),
      d7reset: formatResetTime(bucket.secondary.resetsAt),
    };
  } catch (err) {
    logger.debug({ err }, 'Failed to fetch Codex usage');
    return null;
  }
}

function formatResetTime(resetsAt: string | number): string {
  if (!resetsAt) return '';
  const resetDate =
    typeof resetsAt === 'number'
      ? new Date(resetsAt * 1000)
      : new Date(resetsAt);
  if (isNaN(resetDate.getTime())) return '';

  const now = Date.now();
  const diffMs = resetDate.getTime() - now;
  if (diffMs <= 0) return '곧 리셋';

  const hours = Math.floor(diffMs / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainHours = hours % 24;
    return `${days}d ${remainHours}h`;
  }
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function resolveCodexBin(): string {
  const candidates = [
    path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
    path.join(os.homedir(), '.nvm/versions/node', 'v24.14.0', 'bin', 'codex'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'codex'; // rely on PATH
}
