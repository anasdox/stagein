import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ScreenFrame } from './lua-host';

/**
 * The emulator's front panel: the 128×64 screen, the three encoders, the three
 * keys, and a MIDI monitor. This replaces the physical device — everything the
 * relay sees is identical either way.
 */
export interface PanelHooks {
  enc(n: number, delta: number): void;
  key(n: number, z: number): void;
  pair(session: string, token?: string): void;
  snapshot(): PanelSnapshot;
}

export interface PanelSnapshot {
  device: Record<string, unknown>;
  relay: { connected: boolean; url: string; session: string; error: string | null };
  midi: { count: number; recent: Array<{ at: number; channel: number; cc: number; value: number }> };
}

export class PanelServer {
  private server: Server;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private lastFrame: ScreenFrame | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private readonly html: string;

  constructor(
    private readonly port: number,
    private readonly hooks: PanelHooks,
  ) {
    this.html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');

    this.server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/healthz') {
        const snap = this.hooks.snapshot();
        res.writeHead(snap.relay.connected ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: snap.relay.connected, relay: snap.relay }));
        return;
      }
      if (path === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(this.hooks.snapshot()));
        return;
      }
      if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(this.html);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });

    this.wss = new WebSocketServer({ server: this.server, path: '/panel', maxPayload: 4096 });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    if (this.lastFrame) this.send(ws, { t: 'screen', frame: this.lastFrame });
    this.send(ws, { t: 'snapshot', ...this.hooks.snapshot() });

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.t === 'enc') {
        const n = Number(msg.n);
        const d = Number(msg.d);
        if (n >= 1 && n <= 3 && Number.isFinite(d)) this.hooks.enc(n, Math.max(-16, Math.min(16, d)));
      } else if (msg.t === 'key') {
        const n = Number(msg.n);
        const z = Number(msg.z);
        if (n >= 1 && n <= 3 && (z === 0 || z === 1)) this.hooks.key(n, z);
      } else if (msg.t === 'pair') {
        const session = String(msg.session ?? '').trim();
        const token = msg.token ? String(msg.token) : undefined;
        if (/^[A-Za-z0-9]{4,16}$/.test(session)) this.hooks.pair(session, token);
      }
    });

    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* dropped panel client */
    }
  }

  private broadcast(msg: unknown): void {
    for (const ws of this.clients) this.send(ws, msg);
  }

  /** Called on every `screen.update()` from Lua. */
  pushScreen(frame: ScreenFrame): void {
    this.lastFrame = frame;
    if (this.clients.size > 0) this.broadcast({ t: 'screen', frame });
  }

  pushLog(level: string, message: string): void {
    this.broadcast({ t: 'log', at: Date.now(), level, message });
  }

  pushCc(event: { at: number; channel: number; cc: number; value: number }): void {
    this.broadcast({ t: 'cc', event });
  }

  start(): void {
    this.server.listen(this.port, '0.0.0.0', () => {
      console.log(`[panel] Norns front panel on http://localhost:${this.port}`);
    });
    this.pushTimer = setInterval(() => {
      if (this.clients.size > 0) this.broadcast({ t: 'snapshot', ...this.hooks.snapshot() });
    }, 200);
  }

  stop(): void {
    if (this.pushTimer) clearInterval(this.pushTimer);
    for (const ws of this.clients) ws.close(1001, 'shutting down');
    this.wss.close();
    this.server.close();
  }
}
