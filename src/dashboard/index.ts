import path from 'node:path';

import type { AgentEventBus } from '../agent-events.js';
import { DATA_DIR, GROUPS_DIR, LOGS_DIR } from '../config.js';
import { reloadGroupState, state } from '../group-state.js';
import type { GroupQueue } from '../group-queue.js';
import { logger } from '../logger.js';
import { resetGroupSession } from '../session-reset.js';
import { updateGroupModel } from '../db.js';
import { LiveStateReader } from './adapters/state-adapter.js';
import { LiveQueueReader } from './adapters/queue-adapter.js';
import { dashboardConfig, signalsConfig } from './config.js';
import { LiveStateCache } from './live-state.js';
import { createRouter } from './router.js';
import { createHttpServer } from './server.js';
import { AutomationService } from './services/automation-service.js';
import { GroupsEditorService } from './services/groups-editor-service.js';
import { GroupsService } from './services/groups-service.js';
import { LogSignalsService } from './services/log-signals-service.js';
import { LogsService } from './services/logs-service.js';
import { SkillScanner } from './services/skill-scanner.js';
import { EventThrottle } from './throttle.js';
import { WsHub } from './ws-hub.js';

export interface DashboardDeps {
  agentEvents: AgentEventBus;
  queue: GroupQueue;
  /** Called after any dashboard-originated task mutation. Host uses this to
   *  rewrite per-group IPC task snapshots so containers see fresh state. */
  onTasksChanged: () => void;
  /**
   * Terminate a running container for a group. Used by the
   * `POST /api/groups/:jid/reset-session` endpoint. Host injects
   * `queue.terminateGroup`.
   */
  terminateGroup: (jid: string) => Promise<void>;
  /** Delete the DB session record for a group folder. */
  deleteSession: (folder: string) => void;
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

    const skillScanner = new SkillScanner({
      globalSkillsDir: path.resolve(process.cwd(), 'container', 'skills'),
      groupsDir: GROUPS_DIR,
    });

    const groupsEditorService = new GroupsEditorService({
      state: stateReader,
      skills: skillScanner,
      getSessions: () => state.sessions,
      groupsDir: GROUPS_DIR,
      updateGroupModel,
      reloadGroupState,
    });

    const automationService = new AutomationService({
      onTasksChanged: deps.onTasksChanged,
    });

    const logsService = new LogsService({ logsDir: LOGS_DIR });

    // Hub is assigned after the server exists. LogSignalsService closes over
    // a mutable ref so onSignalChange can broadcast once wiring is complete.
    let hub: WsHub | null = null;

    const logSignalsService = new LogSignalsService({
      logs: logsService,
      events: deps.agentEvents,
      config: signalsConfig(),
      onSignalChange: (status, signal) => {
        hub?.broadcastFrame({ type: 'signal', status, signal });
      },
    });

    const router = createRouter({
      groups: groupsService,
      groupsEditor: groupsEditorService,
      automation: automationService,
      logs: logsService,
      signals: logSignalsService,
      resetSession: (jid, group) =>
        resetGroupSession(jid, group, {
          dataDir: DATA_DIR,
          sessions: state.sessions,
          terminateGroup: deps.terminateGroup,
          deleteSession: deps.deleteSession,
        }),
    });
    const { server } = createHttpServer({ router });

    hub = new WsHub(server, groupsService);
    logSignalsService.start();

    const throttle = new EventThrottle((ev) => hub.broadcast(ev));
    const unsubscribe = deps.agentEvents.on('*', (ev) => throttle.push(ev));
    const unsubscribeLogs = logsService.subscribe((entry) => {
      hub?.broadcastFrame({ type: 'log', entry });
    });

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

    const capturedHub = hub;
    return {
      port: cfg.port,
      async stop(): Promise<void> {
        unsubscribe();
        unsubscribeLogs();
        logSignalsService.shutdown();
        await logsService.shutdown();
        liveCache.detach();
        capturedHub.close();
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
