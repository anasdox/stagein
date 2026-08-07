import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import QRCode from 'qrcode';

import { TokenBucket } from '@stagein/protocol';

import type { RelayConfig } from './config';
import { logger } from './log';
import type { SessionStore } from './store';

const log = logger('http');

const PUBLIC_DIR = resolve(__dirname, '..', 'public');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** Session creation is the one write endpoint open to the world: throttle it. */
const createLimiters = new Map<string, TokenBucket>();
const MAX_SESSIONS = 200;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendFile(res: ServerResponse, path: string): void {
  const type = CONTENT_TYPES[extname(path)] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    // The UIs are tiny and change with the build; never let a phone cache a
    // stale pad during a set.
    'cache-control': 'no-cache',
  });
  createReadStream(path).pipe(res);
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

async function readBody(req: IncomingMessage, limit = 4096): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createHttpServer(store: SessionStore, config: RelayConfig): Server {
  return createServer((req, res) => {
    handle(req, res, store, config).catch((err) => {
      log.error('request failed', err);
      if (!res.headersSent) json(res, 500, { error: 'server_error' });
      else res.end();
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: SessionStore,
  config: RelayConfig,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (path === '/healthz') {
    const sessions = store.list();
    return json(res, 200, {
      ok: true,
      sessions: sessions.length,
      norns: sessions.filter((s) => s.hasNorns()).length,
      uptimeSec: Math.round(process.uptime()),
    });
  }

  // --- session API ---------------------------------------------------------

  if (path === '/api/sessions' && req.method === 'POST') {
    if (!config.allowPublicSessionCreate) {
      // A public relay would otherwise hand a host token and a Norns token to
      // anybody who asks. Sessions come from configuration in production.
      return json(res, 403, { error: 'session_creation_disabled' });
    }
    const ip = clientIp(req);
    let bucket = createLimiters.get(ip);
    if (!bucket) {
      bucket = new TokenBucket(5, 0.2, Date.now());
      createLimiters.set(ip, bucket);
    }
    if (!bucket.take(Date.now())) return json(res, 429, { error: 'rate_limited' });
    if (store.list().length >= MAX_SESSIONS) return json(res, 503, { error: 'too_many_sessions' });

    let body: Record<string, unknown> = {};
    try {
      body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: 'bad_body' });
    }

    const session = store.create();
    if (typeof body.preset === 'string') session.configure({ preset: body.preset }, 'host');

    log.info(`created session ${session.id} for ${ip}`);
    return json(res, 201, {
      sessionId: session.id,
      hostToken: session.hostToken,
      nornsToken: session.nornsToken,
      joinUrl: session.joinUrl,
      hostUrl: session.hostUrl,
      stageUrl: session.stageUrl,
    });
  }

  const apiMatch = /^\/api\/sessions\/([A-Za-z0-9]{1,16})(\/[a-z.]+)?$/.exec(path);
  if (apiMatch) {
    const session = store.get(apiMatch[1]!);
    if (!session) return json(res, 404, { error: 'unknown_session' });
    const sub = apiMatch[2] ?? '';

    if (sub === '' || sub === '/public') {
      return json(res, 200, session.publicState());
    }
    if (sub === '/qr.svg') {
      // Public on purpose: it encodes the join link, which is meant to be seen.
      const svg = await QRCode.toString(session.joinUrl, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000ff', light: '#ffffffff' },
      });
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      return void res.end(svg);
    }
    return notFound(res);
  }

  // --- page routes ---------------------------------------------------------

  const pageRoutes: Array<[RegExp, string]> = [
    [/^\/j\/([A-Za-z0-9]{1,16})\/?$/, 'join.html'],
    [/^\/host\/([A-Za-z0-9]{1,16})\/?$/, 'host.html'],
    [/^\/stage\/([A-Za-z0-9]{1,16})\/?$/, 'stage.html'],
  ];
  for (const [pattern, file] of pageRoutes) {
    const match = pattern.exec(path);
    if (!match) continue;
    if (!store.get(match[1]!)) return notFound(res);
    return sendFile(res, join(PUBLIC_DIR, file));
  }

  if (path === '/' || path === '/index.html') {
    // The bare domain is the join link. It is what a QR on a wall can carry and
    // what can be said into a microphone, and with one session per deployment
    // the code in the path disambiguates nothing.
    //
    // Without a primary session there is nothing to join, so the landing page
    // stands in — which is also the only place session creation makes sense.
    const primary = store.primary();
    return sendFile(res, join(PUBLIC_DIR, primary ? 'join.html' : 'index.html'));
  }
  if (path === '/new') {
    return sendFile(res, join(PUBLIC_DIR, 'index.html'));
  }

  // --- static --------------------------------------------------------------

  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
  if (existsSync(filePath) && statSync(filePath).isFile()) return sendFile(res, filePath);

  return notFound(res);
}
