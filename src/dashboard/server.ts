import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Built server sits at dist/dashboard/; web bundle sits at web/dist/.
// Resolve relative to the compiled server file so the path works in
// both `tsx src/index.ts` and `node dist/index.js`.
const WEB_DIST_CANDIDATES = [
  path.resolve(__dirname, '../../web/dist'),
  path.resolve(__dirname, '../../../web/dist'),
];

function resolveWebDist(): string | null {
  for (const candidate of WEB_DIST_CANDIDATES) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export interface HttpServerBundle {
  app: Express;
  server: http.Server;
}

export interface HttpServerDeps {
  router: Router;
}

export function createHttpServer(deps: HttpServerDeps): HttpServerBundle {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // API routes first
  app.use('/api', deps.router);

  // Static web bundle — optional (dev uses Vite server on :5173 via proxy).
  const webDist = resolveWebDist();
  if (webDist) {
    app.use(express.static(webDist, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
        return next();
      }
      res.sendFile(path.join(webDist, 'index.html'), (err) => {
        if (err) next();
      });
    });
  }

  // Layer C: app-level final error handler. Catches throws from any handler
  // (including middleware registered outside the dashboard router) so a bug
  // cannot crash the host. Must be registered LAST — after static + SPA.
  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      logger.error(
        { scope: 'dashboard', err },
        'unhandled error in dashboard request',
      );
      if (!res.headersSent) {
        res.status(500).json({ v: 1, ok: false, error: 'internal' });
      }
    },
  );

  const server = http.createServer(app);
  server.on('error', (err) => {
    logger.error({ scope: 'dashboard', err }, 'http server error');
  });
  return { app, server };
}
