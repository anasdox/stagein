import WebSocket from 'ws';

import type { NornsConfig } from './config';

/**
 * The Norns side of the link. PRD §11: no inbound access to the venue network —
 * the device always dials out, and keeps redialling.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private backoff: number;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  sessionId: string;
  nornsToken: string;
  lastError: string | null = null;

  constructor(
    private readonly config: NornsConfig,
    private readonly hooks: {
      onOpen(): void;
      onClose(): void;
      onMessage(payload: string): void;
      onLog(level: string, message: string): void;
    },
  ) {
    this.sessionId = config.sessionId;
    this.nornsToken = config.nornsToken;
    this.backoff = config.reconnectMinMs;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get url(): string {
    const base = this.config.relayWsUrl;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}session=${encodeURIComponent(this.sessionId)}`;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Re-pair to a different session, the way you would retype a code on stage. */
  pair(sessionId: string, nornsToken?: string): void {
    this.sessionId = sessionId.toUpperCase();
    if (nornsToken) this.nornsToken = nornsToken;
    this.hooks.onLog('info', `pairing with ${this.sessionId}`);
    this.backoff = this.config.reconnectMinMs;
    this.ws?.close(1000, 're-pairing');
    this.ws = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.url;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = this.config.reconnectMinMs;
      this.lastError = null;
      ws.send(JSON.stringify({ t: 'hello', nornsToken: this.nornsToken, firmware: 'stagein-sim 0.2' }));
      this.hooks.onLog('info', `connected to ${url}`);
      this.hooks.onOpen();
    });

    ws.on('message', (raw) => {
      this.hooks.onMessage(raw.toString('utf8'));
    });

    ws.on('close', (code, reason) => {
      const why = reason.toString('utf8');
      if (code !== 1000) this.lastError = `closed ${code}${why ? ` ${why}` : ''}`;
      this.hooks.onClose();
      this.ws = null;
      this.scheduleRetry();
    });

    ws.on('error', (err) => {
      this.lastError = err.message;
      // 'close' always follows, which is where the retry is scheduled.
    });
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.config.reconnectMaxMs, Math.round(this.backoff * 1.7));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  send(payload: string): void {
    if (!this.connected) return;
    try {
      this.ws?.send(payload);
    } catch (err) {
      this.hooks.onLog('warn', `send failed: ${String(err)}`);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close(1000, 'shutting down');
    this.ws = null;
  }
}
