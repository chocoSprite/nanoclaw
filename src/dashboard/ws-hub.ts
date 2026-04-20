import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { AgentEventV1 } from '../agent-events.js';
import type { GroupsService } from './services/groups-service.js';
import type { WsMessage } from './events.js';
import { logger } from '../logger.js';
import { runInIsolation } from './isolation.js';

const MAX_CLIENTS = 32;
const HEARTBEAT_MS = 30_000;

interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
}

export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<TrackedSocket>();
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly httpServer: HttpServer,
    private readonly groups: GroupsService,
  ) {
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      if (req.url !== '/ws') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.attach(ws as TrackedSocket);
      });
    });

    this.wss.on('error', (err) => {
      logger.error({ scope: 'dashboard', err }, 'WebSocketServer error');
    });

    this.startHeartbeat();
  }

  broadcast(ev: AgentEventV1): void {
    if (this.closed) return;
    this.broadcastFrame({ type: 'event', event: ev });
  }

  broadcastFrame(frame: WsMessage): void {
    if (this.closed) return;
    const payload = JSON.stringify(frame);
    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      try {
        ws.send(payload);
      } catch (err) {
        logger.warn({ scope: 'dashboard', err }, 'ws broadcast send failed');
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const ws of this.clients) {
      try {
        ws.close(1001, 'server shutdown');
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.wss.close();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private attach(ws: TrackedSocket): void {
    if (this.clients.size >= MAX_CLIENTS) {
      ws.close(1013, 'too many clients');
      return;
    }
    this.clients.add(ws);
    ws.isAlive = true;

    runInIsolation(() => {
      const snapshot = this.groups.listLive();
      this.sendTo(ws, { type: 'snapshot', groups: snapshot });
    }, 'ws:initial-snapshot');

    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('close', () => {
      this.clients.delete(ws);
    });
    ws.on('error', (err) => {
      logger.warn({ scope: 'dashboard', err }, 'ws client error');
      this.clients.delete(ws);
    });
  }

  private sendTo(ws: WebSocket, msg: WsMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      logger.warn({ scope: 'dashboard', err }, 'ws send failed');
    }
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          // ignore
        }
      }
    }, HEARTBEAT_MS);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }
}
