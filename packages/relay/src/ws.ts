import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  TokenBucket,
  parseFrame,
  validateHostIn,
  validateNornsIn,
  validateParticipantIn,
} from '@stagein/protocol';

import type { RelayConfig } from './config';
import { logger } from './log';
import { tokenEquals } from './ids';
import type { LiveSession, Participant } from './session';
import type { SessionStore } from './store';

const log = logger('ws');

/** Ceiling on control traffic per socket, independent of the pad rate limit. */
const CONTROL_BURST = 40;
const CONTROL_PER_SEC = 20;

type Role = 'participant' | 'host' | 'norns' | 'stage';

function close(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.send(JSON.stringify({ t: 'error', code: 'bad_session', message: reason }));
  } catch {
    /* socket already gone */
  }
  ws.close(code, reason);
}

export function createWsServer(store: SessionStore, config: RelayConfig): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxFrameBytes });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, context: { role: Role; session: LiveSession }) => {
    const { role, session } = context;
    const bucket = new TokenBucket(CONTROL_BURST, CONTROL_PER_SEC, Date.now());

    switch (role) {
      case 'participant':
        handleParticipant(ws, session, bucket, config);
        break;
      case 'host':
        handleHost(ws, session, bucket);
        break;
      case 'norns':
        handleNorns(ws, session, bucket);
        break;
      case 'stage':
        handleStage(ws, session);
        break;
    }
  });

  return wss;
}

/**
 * Resolve an upgrade request to a role + session. Rejecting here keeps unknown
 * sessions and dead QR codes from ever reaching a handler.
 */
export function resolveUpgrade(
  url: URL,
  store: SessionStore,
): { role: Role; session: LiveSession } | { error: string } {
  const path = url.pathname;
  const sessionId = url.searchParams.get('session') ?? '';
  // No session named: the relay's primary one, so a bare link works.
  const session = sessionId ? store.get(sessionId) : store.primary();
  if (!session) return { error: 'unknown session' };

  if (path === '/ws/participant') {
    // The key is what a rotated QR invalidates (PRD §11) — only meaningful when
    // the link circulates out of sight. A code shown to a room was never secret.
    if (session.joinKeyRequired) {
      const key = url.searchParams.get('k') ?? '';
      if (!tokenEquals(key, session.joinKey)) return { error: 'stale join link' };
    }
    return { role: 'participant', session };
  }
  if (path === '/ws/host') return { role: 'host', session };
  if (path === '/ws/norns') return { role: 'norns', session };
  if (path === '/ws/stage') return { role: 'stage', session };
  return { error: 'unknown endpoint' };
}

// ---------------------------------------------------------------------------
// Participant
// ---------------------------------------------------------------------------

function handleParticipant(
  ws: WebSocket,
  session: LiveSession,
  bucket: TokenBucket,
  config: RelayConfig,
): void {
  let participant: Participant | null = null;

  ws.on('message', (raw) => {
    const now = Date.now();
    const frame = parseFrame(raw as Buffer, config.maxFrameBytes);
    if (!frame.ok) return void close(ws, 4400, frame.error);

    const parsed = validateParticipantIn(frame.value);
    if (!parsed.ok) {
      ws.send(JSON.stringify({ t: 'error', code: 'bad_message', message: parsed.error }));
      return;
    }
    const msg = parsed.value;

    // Pad samples carry their own limiter; everything else shares this one.
    if (msg.t !== 'xy' && msg.t !== 'pong' && !bucket.take(now)) {
      ws.send(JSON.stringify({ t: 'error', code: 'rate_limited', message: 'too many commands' }));
      return;
    }

    if (msg.t === 'hello') {
      participant = session.attachParticipant(msg.clientId, msg.pseudo ?? '', ws);
      return;
    }
    if (!participant) {
      ws.send(JSON.stringify({ t: 'error', code: 'bad_message', message: 'hello first' }));
      return;
    }
    participant.lastSeenAt = now;

    switch (msg.t) {
      case 'enter':
        session.enter(participant);
        break;
      case 'leave':
        session.leave(participant);
        break;
      case 'pseudo':
        session.setPseudo(participant, msg.pseudo);
        break;
      case 'activate':
        session.activate(participant, msg.grantToken);
        break;
      case 'xy':
        session.handleXy(participant, msg, now);
        break;
      case 'pong':
        session.notePong(participant, msg.id, msg.ts, now);
        break;
    }
  });

  ws.on('close', () => {
    if (participant) session.detachParticipant(participant, ws);
  });
  ws.on('error', (err) => log.warn('participant socket error', err));
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

function handleHost(ws: WebSocket, session: LiveSession, bucket: TokenBucket): void {
  let authorised = false;

  ws.on('message', (raw) => {
    const now = Date.now();
    const frame = parseFrame(raw as Buffer);
    if (!frame.ok) return void close(ws, 4400, frame.error);

    const parsed = validateHostIn(frame.value);
    if (!parsed.ok) {
      ws.send(JSON.stringify({ t: 'error', code: 'bad_message', message: parsed.error }));
      return;
    }
    const msg = parsed.value;

    if (!authorised) {
      if (msg.t !== 'hello') {
        ws.send(JSON.stringify({ t: 'error', code: 'bad_token', message: 'hello first' }));
        return;
      }
      if (!tokenEquals(msg.hostToken, session.hostToken)) {
        log.warn(`host auth failed on ${session.id}`);
        ws.send(JSON.stringify({ t: 'error', code: 'bad_token', message: 'invalid host token' }));
        ws.close(4401, 'unauthorised');
        return;
      }
      authorised = true;
      session.attachHost(ws);
      return;
    }

    if (msg.t !== 'pong' && !bucket.take(now)) {
      ws.send(JSON.stringify({ t: 'error', code: 'rate_limited', message: 'too many commands' }));
      return;
    }

    switch (msg.t) {
      case 'hello':
        break;
      case 'open':
        session.open();
        break;
      case 'close':
        session.close();
        break;
      case 'reset':
        session.reset();
        break;
      case 'draw':
        session.draw(msg.countdownMs);
        break;
      case 'revoke':
        session.revoke();
        break;
      case 'kill':
        session.kill('host');
        break;
      case 'unkill':
        session.unkill();
        break;
      case 'config':
        session.configure(msg.patch, 'host');
        break;
      case 'block':
        session.block(msg.clientId);
        break;
      case 'hideNames':
        session.setHideNames(msg.hidden);
        break;
      case 'rotate':
        session.rotateJoinKey();
        break;
      case 'pong':
        break;
    }
    session.flush(true);
  });

  ws.on('close', () => session.detachHost(ws));
  ws.on('error', (err) => log.warn('host socket error', err));
}

// ---------------------------------------------------------------------------
// Norns
// ---------------------------------------------------------------------------

function handleNorns(ws: WebSocket, session: LiveSession, bucket: TokenBucket): void {
  let authorised = false;

  ws.on('message', (raw) => {
    const now = Date.now();
    const frame = parseFrame(raw as Buffer);
    if (!frame.ok) return void close(ws, 4400, frame.error);

    const parsed = validateNornsIn(frame.value);
    if (!parsed.ok) {
      ws.send(JSON.stringify({ t: 'error', code: 'bad_message', message: parsed.error }));
      return;
    }
    const msg = parsed.value;

    if (!authorised) {
      if (msg.t !== 'hello') {
        ws.send(JSON.stringify({ t: 'error', code: 'bad_token', message: 'hello first' }));
        return;
      }
      if (!tokenEquals(msg.nornsToken, session.nornsToken)) {
        log.warn(`norns auth failed on ${session.id}`);
        ws.send(JSON.stringify({ t: 'error', code: 'bad_token', message: 'invalid norns token' }));
        ws.close(4401, 'unauthorised');
        return;
      }
      authorised = true;
      session.attachNorns(ws, msg.firmware);
      return;
    }

    // Status and latency reports are high-frequency by design; do not charge them.
    if (msg.t !== 'status' && msg.t !== 'latency' && msg.t !== 'pong' && !bucket.take(now)) return;

    switch (msg.t) {
      case 'hello':
        break;
      case 'status':
        session.updateNornsStatus(msg.status, now);
        break;
      case 'latency':
        session.noteNornsLatency(msg.ms);
        break;
      case 'kill':
        session.kill('norns');
        break;
      case 'arm':
        // Arming is a device-local decision; it arrives through `status`.
        break;
      case 'open':
        session.open();
        session.flush(true);
        break;
      case 'draw':
        session.draw(msg.countdownMs);
        session.flush(true);
        break;
      case 'config':
        session.configure(msg.patch, 'norns');
        break;
      case 'pong':
        break;
    }
  });

  ws.on('close', () => session.detachNorns(ws));
  ws.on('error', (err) => log.warn('norns socket error', err));
}

// ---------------------------------------------------------------------------
// Stage (read-only)
// ---------------------------------------------------------------------------

function handleStage(ws: WebSocket, session: LiveSession): void {
  session.attachStage(ws);
  // View-only, with one exception: the relay heartbeats this socket, so a
  // correct client answers `pong`. Closing on that would disconnect exactly the
  // clients that behave — a projector dropping mid-set every heartbeat.
  ws.on('message', (raw) => {
    const frame = parseFrame(raw as Buffer);
    if (frame.ok && frame.value.t === 'pong') return;
    ws.close(4400, 'read-only endpoint');
  });
  ws.on('close', () => session.detachStage(ws));
  ws.on('error', (err) => log.warn('stage socket error', err));
}
