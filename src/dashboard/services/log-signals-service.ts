/**
 * Derived log signals — subscribes to the logs stream + agent event bus and
 * upserts rows in `log_signals` when one of three patterns fires. The resulting
 * signals drive the TopBar bell dropdown and the LogsPage banner.
 *
 * Detection kinds:
 *  - `oauth_failure`      401/403 on the host logger (Slack/OneCLI scopes)
 *  - `crash_loop`         container.exited with non-zero exitCode N times in W seconds
 *  - `upstream_outage`    5xx / overloaded errors from Claude/Codex providers (multi-group)
 *
 * Upsert rule: `(kind, COALESCE(group_folder, ''))` has at most one active row
 * (partial unique index in db-schema#12). Bumping an active row keeps first_seen
 * and increments count; auto-resolve sweep flips resolved_at after 24h quiet.
 * User dismiss flips dismissed_at; both close the row for routing purposes.
 *
 * All subscriber callbacks are wrapped in `runInIsolation` — a throw here must
 * not poison the logs stream, agent bus, or the sweep timer.
 */

import type { AgentEventBus } from '../../agent-events.js';
import {
  autoResolveSignals,
  bumpSignal,
  dismissSignalRow,
  findActiveSignal,
  insertSignal,
  listSignals,
} from '../../db.js';
import type { LogSignalKind, LogSignalRow } from '../../types.js';
import type { SignalsConfig } from '../config.js';
import { runInIsolation } from '../isolation.js';
import { logger } from '../../logger.js';
import type { LogEntry, LogsService } from './logs-service.js';

/** DTO shape used by the dashboard router + WS frames (camelCase, parsed details). */
export interface LogSignal {
  id: number;
  kind: LogSignalKind;
  groupFolder: string | null;
  severity: 'warn' | 'error';
  firstSeen: string;
  lastSeen: string;
  count: number;
  details: Record<string, unknown>;
  resolvedAt: string | null;
  dismissedAt: string | null;
}

export type SignalChangeStatus = 'active' | 'resolved';

export interface LogSignalsServiceOptions {
  logs: LogsService;
  events: AgentEventBus;
  config: SignalsConfig;
  onSignalChange: (status: SignalChangeStatus, signal: LogSignal) => void;
  /** Injectable clock for tests. Returns ms since epoch. */
  now?: () => number;
}

// --- Detection predicates ---

const OAUTH_FAILURE_RE = /\b40[13]\b/;
const UPSTREAM_STATUS_RE = /\b5\d\d\b/;
const UPSTREAM_PROVIDER_RE = /claude|anthropic|codex|openai/i;
const UPSTREAM_KEYWORD_RE = /overloaded|rate.?limit/i;

function extractRawStatus(raw: Record<string, unknown>): number | null {
  const s = raw.status;
  if (typeof s === 'number' && s >= 100 && s < 600) return s;
  return null;
}

function matchesOauthFailure(entry: LogEntry): boolean {
  if (entry.levelNum < 50) return false;
  return OAUTH_FAILURE_RE.test(entry.msg);
}

function matchesUpstreamOutage(entry: LogEntry): boolean {
  if (entry.levelNum < 50) return false;
  const hasProvider =
    UPSTREAM_PROVIDER_RE.test(entry.msg) ||
    typeof entry.raw.provider === 'string';
  if (!hasProvider) return false;
  const status = extractRawStatus(entry.raw);
  if (status !== null && status >= 500 && status <= 599) return true;
  if (UPSTREAM_STATUS_RE.test(entry.msg)) return true;
  if (UPSTREAM_KEYWORD_RE.test(entry.msg)) return true;
  return false;
}

// --- Service ---

export class LogSignalsService {
  private unsubscribeLogs: (() => void) | null = null;
  private unsubscribeExited: (() => void) | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly crashLoopWindow = new Map<string, number[]>();
  private readonly upstreamWindow: number[] = [];
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly opts: LogSignalsServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Wire up subscriptions and start the sweep timer. */
  start(): void {
    if (this.stopped) throw new Error('log-signals-service: already stopped');
    if (this.unsubscribeLogs) return;

    this.unsubscribeLogs = this.opts.logs.subscribe((entry) => {
      runInIsolation(() => this.handleLogEntry(entry), 'log-signals:entry');
    });

    this.unsubscribeExited = this.opts.events.on('container.exited', (ev) => {
      runInIsolation(
        () => this.handleContainerExited(ev.groupFolder, ev.exitCode),
        'log-signals:container-exited',
      );
    });

    const periodMs = this.opts.config.sweepIntervalMs;
    if (periodMs > 0) {
      this.sweepTimer = setInterval(() => {
        runInIsolation(() => this.sweep(), 'log-signals:sweep');
      }, periodMs);
      if (this.sweepTimer.unref) this.sweepTimer.unref();
    }
  }

  shutdown(): void {
    this.stopped = true;
    if (this.unsubscribeLogs) {
      this.unsubscribeLogs();
      this.unsubscribeLogs = null;
    }
    if (this.unsubscribeExited) {
      this.unsubscribeExited();
      this.unsubscribeExited = null;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.crashLoopWindow.clear();
    this.upstreamWindow.length = 0;
  }

  listActive(): LogSignal[] {
    return listSignals('active').map(toDto);
  }

  listAll(status: 'active' | 'resolved' | 'all', limit: number): LogSignal[] {
    return listSignals(status, limit).map(toDto);
  }

  dismiss(id: number): LogSignal | undefined {
    const nowIso = new Date(this.now()).toISOString();
    const row = dismissSignalRow(id, nowIso);
    if (!row) return undefined;
    const dto = toDto(row);
    this.emitChange('resolved', dto);
    return dto;
  }

  // --- Handlers ---

  private handleLogEntry(entry: LogEntry): void {
    if (matchesOauthFailure(entry)) {
      this.upsert('oauth_failure', entry.group ?? null, 'error', {
        msg: entry.msg.slice(0, 240),
        time: entry.time,
      });
    }
    if (matchesUpstreamOutage(entry)) {
      const windowMs = this.opts.config.upstreamWindowSec * 1000;
      const nowMs = this.now();
      const ring = this.upstreamWindow;
      ring.push(nowMs);
      while (ring.length > 0 && ring[0] < nowMs - windowMs) ring.shift();
      if (ring.length >= this.opts.config.upstreamCount) {
        this.upsert('upstream_outage', null, 'error', {
          windowSec: this.opts.config.upstreamWindowSec,
          recentCount: ring.length,
          lastMsg: entry.msg.slice(0, 240),
        });
      }
    }
  }

  private handleContainerExited(
    groupFolder: string,
    exitCode: number | null,
  ): void {
    if (exitCode === null || exitCode === 0) return;
    const windowMs = this.opts.config.crashLoopWindowSec * 1000;
    const nowMs = this.now();
    const ring = this.crashLoopWindow.get(groupFolder) ?? [];
    ring.push(nowMs);
    while (ring.length > 0 && ring[0] < nowMs - windowMs) ring.shift();
    this.crashLoopWindow.set(groupFolder, ring);
    if (ring.length >= this.opts.config.crashLoopCount) {
      this.upsert('crash_loop', groupFolder, 'error', {
        windowSec: this.opts.config.crashLoopWindowSec,
        recentExits: ring.length,
        lastExitCode: exitCode,
      });
    }
  }

  private upsert(
    kind: LogSignalKind,
    groupFolder: string | null,
    severity: 'warn' | 'error',
    details: Record<string, unknown>,
  ): void {
    const nowIso = new Date(this.now()).toISOString();
    const detailsJson = JSON.stringify(details);
    const existing = findActiveSignal(kind, groupFolder);
    let row: LogSignalRow;
    if (existing) {
      row = bumpSignal(existing.id, nowIso, detailsJson);
    } else {
      row = insertSignal({
        kind,
        group_folder: groupFolder,
        severity,
        first_seen: nowIso,
        last_seen: nowIso,
        details_json: detailsJson,
      });
    }
    this.emitChange('active', toDto(row));
  }

  private sweep(): void {
    const nowMs = this.now();
    const cutoffMs = nowMs - this.opts.config.autoResolveHours * 3_600_000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const nowIso = new Date(nowMs).toISOString();
    const resolved = autoResolveSignals(cutoffIso, nowIso);
    for (const row of resolved) {
      this.emitChange('resolved', toDto(row));
    }
  }

  private emitChange(status: SignalChangeStatus, signal: LogSignal): void {
    try {
      this.opts.onSignalChange(status, signal);
    } catch (err) {
      logger.warn(
        { scope: 'dashboard', err, signalId: signal.id, status },
        'log-signals: onSignalChange threw',
      );
    }
  }
}

function toDto(row: LogSignalRow): LogSignal {
  let details: Record<string, unknown> = {};
  if (row.details_json) {
    try {
      const parsed = JSON.parse(row.details_json);
      if (parsed && typeof parsed === 'object') {
        details = parsed as Record<string, unknown>;
      }
    } catch {
      // keep empty on parse failure
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    groupFolder: row.group_folder,
    severity: row.severity,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    count: row.count,
    details,
    resolvedAt: row.resolved_at,
    dismissedAt: row.dismissed_at,
  };
}
