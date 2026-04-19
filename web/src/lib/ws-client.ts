import type { WsMessage } from '../contracts';

/**
 * Thin WebSocket client with exponential-ish reconnect backoff. Delivers
 * parsed WsMessage frames to a single listener — the live-store is the
 * single subscriber. Unknown kinds are forwarded as-is; the store silently
 * drops anything its reducer doesn't recognize.
 */

export type WsFrameListener = (msg: WsMessage) => void;
export type WsStatusListener = (status: WsStatus) => void;

export type WsStatus = 'connecting' | 'open' | 'closed' | 'error';

const BACKOFF_STEPS = [1_000, 2_000, 5_000, 15_000];

export interface WsClientOptions {
  url?: string; // defaults to same-origin /ws
  onFrame: WsFrameListener;
  onStatus?: WsStatusListener;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private retryIdx = 0;
  private timer: number | null = null;
  private stopped = false;
  private readonly url: string;

  constructor(private readonly opts: WsClientOptions) {
    this.url = opts.url ?? defaultWsUrl();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private connect(): void {
    this.opts.onStatus?.('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retryIdx = 0;
      this.opts.onStatus?.('open');
    });
    ws.addEventListener('message', (ev) => {
      let parsed: WsMessage;
      try {
        parsed = JSON.parse(String(ev.data)) as WsMessage;
      } catch {
        return; // ignore malformed frames
      }
      try {
        this.opts.onFrame(parsed);
      } catch {
        // listener faults must not kill the socket
      }
    });
    ws.addEventListener('error', () => {
      this.opts.onStatus?.('error');
    });
    ws.addEventListener('close', () => {
      this.ws = null;
      this.opts.onStatus?.('closed');
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay =
      BACKOFF_STEPS[Math.min(this.retryIdx, BACKOFF_STEPS.length - 1)];
    this.retryIdx += 1;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}

function defaultWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}
