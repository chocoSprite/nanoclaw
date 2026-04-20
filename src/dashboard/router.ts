import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { runInIsolation } from './isolation.js';
import { logger } from '../logger.js';
import type { AutomationService } from './services/automation-service.js';
import type { GroupsService } from './services/groups-service.js';
import type {
  LogFilter,
  LogLevel,
  LogsService,
} from './services/logs-service.js';

export interface RouterDeps {
  groups: GroupsService;
  automation: AutomationService;
  logs: LogsService;
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
