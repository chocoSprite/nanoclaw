import type { AgentEventBus } from '../agent-events.js';
import type { GroupQueue } from '../group-queue.js';
import { logger } from '../logger.js';
import { LiveStateReader } from './adapters/state-adapter.js';
import { LiveQueueReader } from './adapters/queue-adapter.js';
import { dashboardConfig } from './config.js';
import { LiveStateCache } from './live-state.js';
import { createRouter } from './router.js';
import { createHttpServer } from './server.js';
import { GroupsService } from './services/groups-service.js';
import { EventThrottle } from './throttle.js';
import { WsHub } from './ws-hub.js';

export interface DashboardDeps {
  agentEvents: AgentEventBus;
  queue: GroupQueue;
}

export interface DashboardHandle {
  port: number;
  stop(): Promise<void>;
}

/**
 * Public facade for the embedded dashboard. Always safe to await from
 * src/index.ts::main(); if the flag is off or a wiring step fails, returns
 * null and logs rather than throwing. The host process must keep running.
 */
export async function startDashboard(
  deps: DashboardDeps,
): Promise<DashboardHandle | null> {
  const cfg = dashboardConfig();
  if (!cfg.enabled) {
    logger.debug(
      { scope: 'dashboard' },
      'DASHBOARD_ENABLED!=1, skipping startup',
    );
    return null;
  }

  try {
    const stateReader = new LiveStateReader();
    const queueReader = new LiveQueueReader(deps.queue);
    const liveCache = new LiveStateCache();
    liveCache.subscribe(deps.agentEvents);

    const groupsService = new GroupsService(
      stateReader,
      queueReader,
      liveCache,
    );

    const router = createRouter({ groups: groupsService });
    const { server } = createHttpServer({ router });

    const hub = new WsHub(server, groupsService);
    const throttle = new EventThrottle((ev) => hub.broadcast(ev));
    const unsubscribe = deps.agentEvents.on('*', (ev) => throttle.push(ev));

    server.on('error', (err) => {
      logger.error({ scope: 'dashboard', err }, 'http server runtime error');
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(cfg.port);
    });

    logger.info({ scope: 'dashboard', port: cfg.port }, 'Dashboard listening');

    return {
      port: cfg.port,
      async stop(): Promise<void> {
        unsubscribe();
        liveCache.detach();
        hub.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  } catch (err) {
    logger.error(
      { scope: 'dashboard', err },
      'Dashboard startup failed — host continues without dashboard',
    );
    return null;
  }
}
