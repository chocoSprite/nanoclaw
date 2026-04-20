import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { runInIsolation } from './isolation.js';
import { logger } from '../logger.js';
import type { ResetResult } from '../session-reset.js';
import type { RegisteredGroup } from '../types.js';
import type { AutomationService } from './services/automation-service.js';
import type { GroupsEditorService } from './services/groups-editor-service.js';
import type { GroupsService } from './services/groups-service.js';
import type { LogSignalsService } from './services/log-signals-service.js';
import type {
  LogFilter,
  LogLevel,
  LogsService,
} from './services/logs-service.js';

export interface RouterDeps {
  groups: GroupsService;
  groupsEditor: GroupsEditorService;
  automation: AutomationService;
  logs: LogsService;
  signals: LogSignalsService;
  /**
   * Reset a group's session. Wrapped around host `resetGroupSession` so
   * the router does not need to know about terminateGroup/dataDir/etc.
   */
  resetSession: (jid: string, group: RegisteredGroup) => Promise<ResetResult>;
}

const LOG_LEVELS: readonly LogLevel[] = [
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
];

function parseLogFilter(req: Request): LogFilter {
  const filter: LogFilter = {};
  const lvl = typeof req.query.level === 'string' ? req.query.level : '';
  if ((LOG_LEVELS as readonly string[]).includes(lvl)) {
    filter.level = lvl as LogLevel;
  }
  if (typeof req.query.group === 'string' && req.query.group) {
    filter.group = req.query.group;
  }
  if (typeof req.query.search === 'string' && req.query.search) {
    filter.search = req.query.search;
  }
  return filter;
}

export function createRouter(deps: RouterDeps): Router {
  const r = Router();

  r.get('/health', (_req, res) => {
    res.json({ v: 1, ok: true });
  });

  r.get('/groups/live', (_req, res) => {
    const out = runInIsolation(
      () => deps.groups.listLive(),
      'GET /api/groups/live',
    );
    res.json({ v: 1, groups: out ?? [] });
  });

  r.get('/groups/editor', (_req, res) => {
    const out = runInIsolation(
      () => deps.groupsEditor.listForEditor(),
      'GET /api/groups/editor',
    );
    res.json({ v: 1, groups: out ?? [] });
  });

  r.patch('/groups/:jid', (req, res) => {
    const body = (req.body ?? {}) as { model?: string | null };
    // `model` not present → nothing to change. Treat as no-op 400 for
    // clarity rather than silent success.
    if (!('model' in body)) {
      res.status(400).json({ v: 1, ok: false, error: 'no_field' });
      return;
    }
    const rawModel = body.model;
    const model =
      rawModel === null || rawModel === undefined ? null : String(rawModel);
    const result = runInIsolation(
      () => deps.groupsEditor.patchModel(req.params.jid, model),
      'PATCH /api/groups/:jid',
    );
    if (!result) {
      // isolation swallowed an error — 500 is fine; router-level handler
      // will also catch but this is defensive.
      res.status(500).json({ v: 1, ok: false, error: 'internal' });
      return;
    }
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 400;
      res.status(status).json({ v: 1, ok: false, error: result.error });
      return;
    }
    res.json({ v: 1, ok: true, group: result.view });
  });

  r.post('/groups/:jid/reset-session', async (req, res, next) => {
    try {
      const jid = req.params.jid;
      const group = deps.groupsEditor.lookupGroup(jid);
      if (!group) {
        res.status(404).json({ v: 1, ok: false, error: 'not_found' });
        return;
      }
      const result = await deps.resetSession(jid, group);
      res.json({ v: 1, ok: true, result });
    } catch (err) {
      next(err);
    }
  });

  // --- Automation ---

  r.get('/automation/tasks', (_req, res) => {
    const out = runInIsolation(
      () => deps.automation.listTasks(),
      'GET /api/automation/tasks',
    );
    res.json({ v: 1, tasks: out ?? [] });
  });

  r.get('/automation/tasks/:id/runs', (req, res) => {
    const id = req.params.id;
    const rawLimit = Number.parseInt(String(req.query.limit ?? '10'), 10);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 100
        ? rawLimit
        : 10;
    const out = runInIsolation(
      () => deps.automation.getTaskRuns(id, limit),
      'GET /api/automation/tasks/:id/runs',
    );
    res.json({ v: 1, runs: out ?? [] });
  });

  r.post('/automation/tasks/:id/pause', (req, res) => {
    const task = runInIsolation(
      () => deps.automation.pauseTask(req.params.id),
      'POST /api/automation/tasks/:id/pause',
    );
    if (!task) {
      res.status(404).json({ v: 1, ok: false, error: 'not_found' });
      return;
    }
    res.json({ v: 1, ok: true, task });
  });

  r.post('/automation/tasks/:id/resume', (req, res) => {
    const task = runInIsolation(
      () => deps.automation.resumeTask(req.params.id),
      'POST /api/automation/tasks/:id/resume',
    );
    if (!task) {
      res.status(404).json({ v: 1, ok: false, error: 'not_found' });
      return;
    }
    res.json({ v: 1, ok: true, task });
  });

  r.post('/automation/tasks/:id/trigger', (req, res) => {
    const task = runInIsolation(
      () => deps.automation.triggerNow(req.params.id),
      'POST /api/automation/tasks/:id/trigger',
    );
    if (!task) {
      res.status(404).json({ v: 1, ok: false, error: 'not_found' });
      return;
    }
    res.json({ v: 1, ok: true, task });
  });

  r.delete('/automation/tasks/:id', (req, res) => {
    const deleted = runInIsolation(
      () => deps.automation.deleteTask(req.params.id),
      'DELETE /api/automation/tasks/:id',
    );
    if (!deleted) {
      res.status(404).json({ v: 1, ok: false, error: 'not_found' });
      return;
    }
    res.json({ v: 1, ok: true });
  });

  // --- Logs ---

  r.get('/logs/recent', async (req, res, next) => {
    try {
      const filter = parseLogFilter(req);
      const rawLimit = Number.parseInt(String(req.query.limit ?? '200'), 10);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 1000
          ? rawLimit
          : 200;
      const entries = await deps.logs.readRecent(filter, limit);
      res.json({ v: 1, entries });
    } catch (err) {
      next(err);
    }
  });

  // --- Log Signals ---

  r.get('/logs/signals', (req, res) => {
    const rawStatus =
      typeof req.query.status === 'string' ? req.query.status : 'active';
    const status: 'active' | 'resolved' | 'all' =
      rawStatus === 'resolved' || rawStatus === 'all' ? rawStatus : 'active';
    const rawLimit = Number.parseInt(String(req.query.limit ?? '100'), 10);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 500
        ? rawLimit
        : 100;
    const signals = runInIsolation(
      () => deps.signals.listAll(status, limit),
      'GET /api/logs/signals',
    );
    res.json({ v: 1, signals: signals ?? [] });
  });

  r.post('/logs/signals/:id/dismiss', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ v: 1, ok: false, error: 'invalid_id' });
      return;
    }
    const signal = runInIsolation(
      () => deps.signals.dismiss(id),
      'POST /api/logs/signals/:id/dismiss',
    );
    if (!signal) {
      res.status(404).json({ v: 1, ok: false, error: 'not_found' });
      return;
    }
    res.json({ v: 1, ok: true, signal });
  });

  // Layer C: final error handler so a throwing handler cannot crash the host.
  r.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      logger.error({ scope: 'dashboard', err }, 'router error');
      if (!res.headersSent) {
        res.status(500).json({ v: 1, ok: false, error: 'internal' });
      }
    },
  );

  return r;
}
