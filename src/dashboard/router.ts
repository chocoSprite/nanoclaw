import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { runInIsolation } from './isolation.js';
import { logger } from '../logger.js';
import type { GroupsService } from './services/groups-service.js';

export interface RouterDeps {
  groups: GroupsService;
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
