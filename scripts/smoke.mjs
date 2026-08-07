#!/usr/bin/env node
/**
 * End-to-end acceptance check for the MVP criteria in PRD §14.
 *
 * Runs against a live stack (`mise run up` or `mise run dev`) and drives the
 * real pieces: the relay over its three WebSocket surfaces, and the Norns
 * simulator through its front panel — so the Lua script, its mapping and its
 * kill switch are all exercised, not mocked.
 *
 *   mise run up      # in one terminal
 *   mise run smoke   # in another
 */

import { randomBytes } from 'node:crypto';

const RELAY = (process.env.SMOKE_RELAY_URL || 'http://localhost:8080').replace(/\/+$/, '');
const PANEL = (process.env.SMOKE_PANEL_URL || 'http://localhost:8081').replace(/\/+$/, '');
const SESSION = (process.env.BOOTSTRAP_SESSION_ID || 'DEMO01').toUpperCase();
const HOST_TOKEN = process.env.BOOTSTRAP_HOST_TOKEN || 'dev-host-token-change-me';

const wsBase = RELAY.replace(/^http/, 'ws');

let passed = 0;
const failures = [];

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function waitFor(label, predicate, { timeout = 8000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

/** Thin wrapper: keeps every frame received so assertions can look back. */
class Client {
  constructor(url, name) {
    this.name = name;
    this.frames = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error(`${name}: socket error`)));
    });
    // Some checks deliberately open a socket that must fail; attach a handler
    // so the expected rejection never surfaces as an unhandled one.
    this.ready.catch(() => {});
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      this.frames.push(msg);
      // Answer heartbeats so presence and clock-offset estimation work.
      if (msg.t === 'ping') this.send({ t: 'pong', id: msg.id, ts: Date.now() });
    });
  }

  send(msg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  last(type) {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i].t === type) return this.frames[i];
    return null;
  }

  all(type) {
    return this.frames.filter((f) => f.t === type);
  }

  clear() {
    this.frames = [];
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const clientId = () => randomBytes(12).toString('base64url');

async function panelState() {
  const res = await fetch(`${PANEL}/api/state`);
  if (!res.ok) throw new Error(`panel /api/state → ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('StageIn — MVP acceptance check');
  console.log(`relay ${RELAY} · panel ${PANEL} · session ${SESSION}`);

  // --- 0. reachability ------------------------------------------------------
  section('0 · stack reachable');
  const health = await fetch(`${RELAY}/healthz`).then((r) => r.json());
  check('relay healthy', health.ok === true, JSON.stringify(health));

  let panel;
  try {
    panel = await panelState();
  } catch (err) {
    console.error(`\n\x1b[31mThe Norns simulator is not reachable at ${PANEL}.\x1b[0m`);
    console.error('Start the stack first: mise run up (or mise run dev)\n');
    throw err;
  }
  check('norns simulator connected to relay', panel.relay.connected === true, panel.relay.session);
  check('norns is running the Lua script', typeof panel.device.preset === 'string', `preset=${panel.device.preset}`);

  // --- 1. host console ------------------------------------------------------
  section('1 · host console (FR-01, FR-02, FR-14)');
  const host = new Client(`${wsBase}/ws/host?session=${SESSION}`, 'host');
  await host.ready;
  host.send({ t: 'hello', hostToken: HOST_TOKEN });
  const welcome = await waitFor('host welcome', () => host.last('welcome'));
  const hostState = welcome.state;
  check('host authenticated', Boolean(hostState.config), `state=${hostState.state}`);
  // The normal link is the bare domain: short enough to read aloud, small
  // enough to make a robust QR, and stable across restarts.
  check(
    'the join link is the bare domain, with no key',
    !hostState.joinUrl.includes('?k=') && new URL(hostState.joinUrl).pathname === '/',
    hostState.joinUrl,
  );
  const joinKey = new URL(hostState.joinUrl).searchParams.get('k');
  const participantUrl = (key = joinKey) =>
    `${wsBase}/ws/participant?session=${SESSION}${key ? `&k=${key}` : ''}`;

  const qr = await fetch(`${RELAY}/api/sessions/${SESSION}/qr.svg`);
  const qrBody = await qr.text();
  check('QR code renders', qr.status === 200 && qrBody.startsWith('<svg'), `${qrBody.length} bytes`);

  const badHost = new Client(`${wsBase}/ws/host?session=${SESSION}`, 'bad-host');
  await badHost.ready;
  badHost.send({ t: 'hello', hostToken: 'not-the-token' });
  const rejected = await waitFor('host rejection', () => badHost.last('error'));
  check('wrong host token refused', rejected.code === 'bad_token');
  badHost.close();

  // A bare link is the point of the default: no key to go stale, nothing to
  // rotate out from under a printed or displayed QR.
  const bare = new Client(`${wsBase}/ws/participant?session=${SESSION}`, 'bare');
  await bare.ready;
  bare.send({ t: 'hello', clientId: clientId(), pseudo: '' });
  const bareWelcome = await waitFor('bare link accepted', () => bare.last('welcome'));
  check('a link with no key is accepted', Boolean(bareWelcome), `session ${bareWelcome.state.sessionId}`);
  bare.close();

  // Revocation still exists for links that circulate out of sight, such as in a
  // stream chat; it is opt-in rather than imposed on a QR shown to a room.
  host.send({ t: 'config', patch: { requireJoinKey: true } });
  await waitFor('key required', () => host.last('state')?.state.joinKeyRequired === true);
  const staleJoin = new Client(`${wsBase}/ws/participant?session=${SESSION}&k=stale-key`, 'stale');
  const staleClosed = await new Promise((resolve) => {
    staleJoin.ws.addEventListener('close', () => resolve(true));
    staleJoin.ws.addEventListener('error', () => resolve(true));
  });
  check('with the key turned on, a stale link is refused (PRD §11)', staleClosed === true);
  const keyed = new URL(host.last('state').state.joinUrl).searchParams.get('k');
  check('and the link then carries one', Boolean(keyed), `?k=${keyed?.slice(0, 6)}…`);
  host.send({ t: 'config', patch: { requireJoinKey: false } });
  await waitFor('key optional again', () => host.last('state')?.state.joinKeyRequired === false);

  // --- 2. arm the device ----------------------------------------------------
  section('2 · Norns arming gate (FR-12)');
  const panelWs = new Client(`${PANEL.replace(/^http/, 'ws')}/panel`, 'panel');
  await panelWs.ready;

  // Clear a kill left over from a previous run, then arm with K3.
  let device = (await panelState()).device;
  if (device.killed) {
    panelWs.send({ t: 'key', n: 3, z: 1 });
    panelWs.send({ t: 'key', n: 3, z: 0 });
    await sleep(150);
  }
  device = (await panelState()).device;
  if (!device.armed) {
    panelWs.send({ t: 'key', n: 3, z: 1 });
    panelWs.send({ t: 'key', n: 3, z: 0 });
  }
  device = await waitFor('device armed', async () => {
    const d = (await panelState()).device;
    return d.armed && !d.killed ? d : null;
  });
  check('K3 arms the device', device.armed === true && device.killed === false);
  check('armed but unauthorised passes nothing', device.authorised === false, 'no grant yet');

  // --- 3. lottery -----------------------------------------------------------
  section('3 · lottery (FR-03…FR-06)');
  host.send({ t: 'reset' });
  await waitFor('session reset', () => host.last('state')?.state.state === 'CLOSED');
  host.send({ t: 'config', patch: { controlDurationMs: 30000, winnerCanRewin: false, activationTimeoutMs: 10000 } });
  host.send({ t: 'open' });
  await waitFor('session open', () => host.last('state')?.state.state === 'OPEN');

  const joinAs = async (name, id = clientId()) => {
    const p = new Client(participantUrl(), name);
    await p.ready;
    p.id = id;
    p.pseudo = name;
    p.send({ t: 'hello', clientId: p.id, pseudo: name });
    await waitFor(`${name} welcome`, () => p.last('welcome'));
    p.send({ t: 'enter' });
    return p;
  };

  const people = [];
  for (const name of ['nova', 'kilo', 'zed']) people.push(await joinAs(name));

  // A phone that brings no pseudonym must still get a usable stage name: the
  // public view has to be able to announce whoever wins (PRD §4).
  const unnamed = new Client(participantUrl(), 'unnamed');
  await unnamed.ready;
  unnamed.send({ t: 'hello', clientId: clientId(), pseudo: '' });
  const assigned = await waitFor('assigned stage name', () => unnamed.last('welcome'));
  check(
    'a device with no pseudonym is given a stage name',
    typeof assigned.pseudo === 'string' && assigned.pseudo.trim().length > 0 && assigned.pseudo !== 'anonyme',
    `"${assigned.pseudo}"`,
  );
  const assignedNames = new Set();
  for (let i = 0; i < 8; i++) {
    const extra = new Client(participantUrl(), `extra${i}`);
    await extra.ready;
    extra.send({ t: 'hello', clientId: clientId(), pseudo: '' });
    const frame = await waitFor(`extra${i} welcome`, () => extra.last('welcome'));
    assignedNames.add(frame.pseudo);
    extra.close();
  }
  check(
    'assigned names do not collide inside a session',
    assignedNames.size === 8,
    `${assignedNames.size}/8 distinct · e.g. ${[...assignedNames].slice(0, 3).join(', ')}`,
  );
  unnamed.close();
  await sleep(200);

  // Moderation. The public view is a projection surface (FR-15), so the relay —
  // not the page — has to refuse a name; a participant can send `pseudo`
  // straight down the socket.
  const abusive = new Client(participantUrl(), 'abusive');
  await abusive.ready;
  abusive.send({ t: 'hello', clientId: clientId(), pseudo: '' });
  const abusiveWelcome = await waitFor('abusive welcome', () => abusive.last('welcome'));
  for (const attempt of ['salope', '5@l0pe', 's a l o p e', 'RAMAS', 'twitch.tv/spam']) {
    abusive.clear();
    abusive.send({ t: 'pseudo', pseudo: attempt });
    const verdict = await waitFor(`"${attempt}" moderated`, () => abusive.last('pseudo'));
    check(
      `"${attempt}" never becomes a stage name`,
      verdict.substituted === true && verdict.pseudo !== attempt,
      `→ "${verdict.pseudo}"`,
    );
  }
  abusive.clear();
  abusive.send({ t: 'pseudo', pseudo: 'Dispute' });
  await sleep(400);
  const innocent = abusive.last('pseudo');
  check(
    'an innocent name that merely contains a banned substring is kept',
    innocent !== null && innocent.substituted === false && innocent.pseudo === 'Dispute',
    `→ "${innocent?.pseudo}"`,
  );
  void abusiveWelcome;
  abusive.close();
  await sleep(200);
  const opened = await waitFor('three entrants', () => {
    const s = host.last('state')?.state;
    return s && s.entrants === 3 ? s : null;
  });
  check('three participants joined with no account', opened.entrants === 3);

  // One entry per device: a second socket for the same clientId takes over the
  // existing record instead of creating a second lottery entry (PRD §7). The
  // relay closes the older socket, which is also the reconnection path (NFR-05).
  const novaId = people[0].id;
  const twin = new Client(participantUrl(), 'twin');
  await twin.ready;
  twin.send({ t: 'hello', clientId: novaId, pseudo: 'nova-again' });
  await sleep(400);
  const afterTwin = host.last('state').state;
  check('one lottery entry per device', afterTwin.entrants === 3, `entrants=${afterTwin.entrants}`);
  const oldSocketClosed = people[0].ws.readyState === 2 || people[0].ws.readyState === 3;
  check('the older socket of the same device is closed', oldSocketClosed);
  twin.close();
  await sleep(200);

  // Rejoin as that device would after a reconnect, and keep the fresh socket.
  people[0].close();
  people[0] = await joinAs('nova', novaId);
  await waitFor('nova back in the lottery', () => host.last('state')?.state.entrants === 3);

  // The relay owns the entry flag. A phone that believes it is in the lottery
  // when the relay disagrees waits for a draw that will never include it.
  const drifting = await joinAs('drifting');
  await waitFor('drifting entered', () => drifting.last('entry')?.entered === true);
  check('entering is confirmed by the relay', drifting.last('entry').entered === true);

  drifting.clear();
  host.send({ t: 'reset' });
  const cleared = await waitFor('entry revoked by reset', () => drifting.last('entry'));
  check(
    'a host reset tells every phone it left the lottery',
    cleared.entered === false,
    'otherwise the waiting screen lies and the phone is never drawn',
  );

  drifting.clear();
  drifting.send({ t: 'enter' }); // registrations are closed after a reset
  const refused = await waitFor('entry refused', () => drifting.last('entry'));
  check(
    'a refused entry is reported, not silently dropped',
    refused.entered === false && drifting.last('error')?.code === 'bad_state',
    `error=${drifting.last('error')?.code}`,
  );
  drifting.close();

  host.send({ t: 'open' });
  await waitFor('reopened for the rest of the run', () => host.last('state')?.state.state === 'OPEN');
  for (const p of people) p.send({ t: 'enter' });
  await waitFor('entrants restored', () => host.last('state')?.state.entrants === 3);

  for (const p of people) p.clear();
  host.send({ t: 'draw', countdownMs: 400 });
  await waitFor('awarded', () => host.last('state')?.state.state === 'AWARDED');
  const winners = people.filter((p) => p.last('won'));
  check('exactly one winner selected', winners.length === 1, `${winners.length} of ${people.length}`);
  const winner = winners[0];
  const losers = people.filter((p) => p !== winner);
  check('only the winner receives a pad token', losers.every((p) => !p.last('won')));

  // The operator's backstop: names withheld at the source, not hidden in CSS.
  const stage = new Client(`${wsBase}/ws/stage?session=${SESSION}`, 'stage');
  await stage.ready;
  const namedFrame = await waitFor('stage state', () => stage.last('state'));
  check('the public view names the winner by default', namedFrame.state.winnerPseudo !== null, `"${namedFrame.state.winnerPseudo}"`);
  const realName = namedFrame.state.winnerPseudo;
  stage.clear();
  host.send({ t: 'hideNames', hidden: true });
  const hiddenFrame = await waitFor('names hidden', () => {
    const f = stage.last('state');
    return f?.state.namesHidden ? f : null;
  });
  check(
    'hiding names keeps them off the public socket entirely',
    hiddenFrame.state.winnerPseudo !== realName,
    `public sees "${hiddenFrame.state.winnerPseudo}"`,
  );
  check(
    'the host still sees the real name to moderate with',
    host.last('state').state.winnerPseudo === realName,
    `host sees "${host.last('state').state.winnerPseudo}"`,
  );
  host.send({ t: 'hideNames', hidden: false });
  await waitFor('names shown again', () => stage.last('state')?.state.namesHidden === false);
  // The stage socket is heartbeated and the client answers; it must not be
  // dropped for that. Two heartbeat periods is enough to catch a regression.
  await sleep(4500);
  check(
    'the public view survives answering heartbeats',
    stage.ws.readyState === 1 && stage.all('ping').length > 0,
    `${stage.all('ping').length} pings answered, socket still open`,
  );
  stage.close();

  // --- 4. authorisation ----------------------------------------------------
  section('4 · authorisation (FR-07, PRD §11)');
  const wonFrame = winner.last('won');
  const loser = losers[0];
  loser.clear();
  loser.send({ t: 'xy', grantToken: wonFrame.grantToken, x: 0.9, y: 0.9, seq: 1, ts: Date.now() });
  const loserError = await waitFor('loser refused', () => loser.last('error'));
  check('a non-winner holding the token is refused', loserError.code === 'not_authorised');

  winner.clear();
  winner.send({ t: 'xy', grantToken: wonFrame.grantToken, x: 0.9, y: 0.9, seq: 1, ts: Date.now() });
  const beforeActivation = await waitFor('pre-activation refused', () => winner.last('error'));
  check('the winner cannot play before activating', beforeActivation.code === 'not_authorised');

  winner.clear();
  winner.send({ t: 'activate', grantToken: wonFrame.grantToken });
  const active = await waitFor('pad active', () => winner.last('active'));
  check('activation opens the control window', Number.isFinite(active.expiresAt));
  await waitFor('norns holds the grant', async () => (await panelState()).device.grantId);

  // --- 5. control path -----------------------------------------------------
  section('5 · gesture → MIDI CC (FR-09…FR-11, NFR-01)');
  const cfg = host.last('state').state.config;
  let seq = 0;
  const sweep = async (fromX, toX, fromY, toY, steps = 18) => {
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;
      winner.send({
        t: 'xy',
        grantToken: wonFrame.grantToken,
        x: fromX + (toX - fromX) * k,
        y: fromY + (toY - fromY) * k,
        seq: ++seq,
        ts: Date.now(),
      });
      await sleep(1000 / cfg.rateHz);
    }
  };

  await sweep(0.5, 1, 0.5, 1);
  await sleep(600); // let the slew settle

  let d = (await panelState()).device;
  check('norns accepted the gesture frames', d.accepted > 10, `accepted=${d.accepted} rejected=${d.rejected}`);
  check(
    `${cfg.macros.x.name} reached the top of its authorised range`,
    d.ccX === Math.max(cfg.macros.x.min, cfg.macros.x.max),
    `CC${cfg.macros.x.cc}=${d.ccX} range=[${cfg.macros.x.min},${cfg.macros.x.max}]`,
  );
  check(
    `${cfg.macros.y.name} reached the top of its authorised range`,
    d.ccY === Math.max(cfg.macros.y.min, cfg.macros.y.max),
    `CC${cfg.macros.y.cc}=${d.ccY} range=[${cfg.macros.y.min},${cfg.macros.y.max}]`,
  );

  const midi = (await panelState()).midi;
  const ccNumbers = new Set(midi.recent.filter((e) => e.cc >= 0).map((e) => e.cc));
  check('two distinct MIDI CC are emitted and verifiable', ccNumbers.size >= 2, `CC ${[...ccNumbers].join(', ')}`);
  check(
    'no emitted value ever leaves 0..127',
    midi.recent.every((e) => e.value >= 0 && e.value <= 127),
  );

  // Out-of-range and replayed frames (PRD §11).
  const droppedBefore = host.last('state').state.metrics.eventsDropped;
  winner.send({ t: 'xy', grantToken: wonFrame.grantToken, x: 42, y: -17, seq: ++seq, ts: Date.now() });
  winner.send({ t: 'xy', grantToken: wonFrame.grantToken, x: 0.2, y: 0.2, seq: 1, ts: Date.now() });
  await sleep(500);
  d = (await panelState()).device;
  check('out-of-range coordinates are clamped, not passed through', d.ccX <= 127 && d.ccX >= 0 && d.ccY <= 127 && d.ccY >= 0, `CC=${d.ccX}/${d.ccY}`);
  const droppedAfter = await waitFor('replay dropped', () => {
    const v = host.last('state').state.metrics.eventsDropped;
    return v > droppedBefore ? v : null;
  });
  check('replayed sequence numbers are dropped', droppedAfter > droppedBefore, `${droppedBefore} → ${droppedAfter}`);

  const metrics = host.last('state').state.metrics;
  check(
    'latency P95 within the NFR-01 budget',
    metrics.latencyP95 != null && metrics.latencyP95 < 250,
    `P50=${metrics.latencyP50}ms P95=${metrics.latencyP95}ms via ${metrics.latencySource}`,
  );

  // --- 5b. device-side barrier ---------------------------------------------
  // The relay does not know whether the device is armed, so it keeps forwarding.
  // Disarming is therefore the one way to prove the Norns enforces the limits
  // independently of the server (PRD §7, NFR-07).
  section('5b · the device enforces its own limits (NFR-07)');
  panelWs.send({ t: 'key', n: 3, z: 1 });
  panelWs.send({ t: 'key', n: 3, z: 0 });
  const disarmed = await waitFor('disarmed', async () => {
    const s = (await panelState()).device;
    return !s.armed && !s.killed ? s : null;
  });
  const rejectedAtDisarm = disarmed.rejected;
  const inBefore = host.last('state').state.metrics.eventsIn;
  const droppedAtDisarm = host.last('state').state.metrics.eventsDropped;
  for (let i = 0; i < 6; i++) {
    winner.send({ t: 'xy', grantToken: wonFrame.grantToken, x: 0.99, y: 0.01, seq: ++seq, ts: Date.now() });
    await sleep(1000 / cfg.rateHz);
  }
  await sleep(700);
  const disarmedState = host.last('state').state.metrics;
  d = (await panelState()).device;
  check(
    'the relay still forwards while the device is disarmed',
    disarmedState.eventsIn > inBefore && disarmedState.eventsDropped === droppedAtDisarm,
    `in ${inBefore} → ${disarmedState.eventsIn}, dropped unchanged at ${disarmedState.eventsDropped}`,
  );
  check(
    'the device refuses the frames itself',
    d.rejected > rejectedAtDisarm,
    `device rejections ${rejectedAtDisarm} → ${d.rejected}`,
  );
  check(
    'a disarmed device holds the safe value regardless of the gesture',
    d.ccX === cfg.macros.x.safe && d.ccY === cfg.macros.y.safe,
    `CC=${d.ccX}/${d.ccY} safe=${cfg.macros.x.safe}/${cfg.macros.y.safe}`,
  );

  // Re-arm and put the pad back in motion for the kill test.
  panelWs.send({ t: 'key', n: 3, z: 1 });
  panelWs.send({ t: 'key', n: 3, z: 0 });
  await waitFor('re-armed', async () => (await panelState()).device.armed);
  await sweep(0.5, 1, 0.5, 1, 10);
  await sleep(500);

  // --- 6. kill switch ------------------------------------------------------
  section('6 · kill switch (FR-12, <100 ms)');
  const killAt = Date.now();
  host.send({ t: 'kill' });
  const killedDevice = await waitFor(
    'device killed',
    async () => {
      const s = await panelState();
      return s.device.killed ? s.device : null;
    },
    { timeout: 3000, interval: 5 },
  );
  const killLatency = Date.now() - killAt;
  check('kill reaches the device in under 100 ms', killLatency < 100, `${killLatency} ms (measured over HTTP polling)`);
  check('kill drops the grant on the device', !killedDevice.grantId || killedDevice.grantId === null);

  // Two independent barriers must both hold: the relay stops forwarding, and
  // the device refuses anything that reaches it anyway (NFR-07).
  const relayDroppedBefore = host.last('state').state.metrics.eventsDropped;
  const deviceRejectedBefore = killedDevice.rejected;
  const ccBefore = { x: killedDevice.ccX, y: killedDevice.ccY };
  for (let i = 0; i < 5; i++) {
    winner.send({ t: 'xy', grantToken: wonFrame.grantToken, x: 0.02, y: 0.98, seq: ++seq, ts: Date.now() });
    await sleep(30);
  }
  await sleep(300);
  d = (await panelState()).device;
  const relayDroppedAfter = host.last('state').state.metrics.eventsDropped;
  check(
    'the relay stops forwarding once killed',
    relayDroppedAfter >= relayDroppedBefore + 5,
    `dropped ${relayDroppedBefore} → ${relayDroppedAfter}`,
  );
  check(
    'the device target never follows a post-kill gesture',
    d.targetX === killedDevice.targetX && d.targetY === killedDevice.targetY,
    `target frozen at ${d.targetX}/${d.targetY}; 0.02/0.98 was requested after the kill`,
  );
  check(
    'nothing reached the device output past the kill',
    d.rejected === deviceRejectedBefore,
    `device rejections unchanged at ${d.rejected}; CC moved toward safe, not toward the gesture (was ${ccBefore.x}/${ccBefore.y}, now ${d.ccX}/${d.ccY})`,
  );

  // FR-13: return to the safe preset value.
  const settled = await waitFor(
    'return to safe values',
    async () => {
      const s = (await panelState()).device;
      return s.ccX === cfg.macros.x.safe && s.ccY === cfg.macros.y.safe ? s : null;
    },
    { timeout: 5000, interval: 50 },
  );
  check('output glides back to the safe preset value (FR-13)', settled.ccX === cfg.macros.x.safe && settled.ccY === cfg.macros.y.safe, `CC=${settled.ccX}/${settled.ccY} safe=${cfg.macros.x.safe}/${cfg.macros.y.safe}`);

  const winnerEnd = winner.last('ended');
  check('the winner is told the control stopped', winnerEnd?.reason === 'killed', `reason=${winnerEnd?.reason}`);

  // --- 7. automatic expiry -------------------------------------------------
  section('7 · automatic expiry (FR-08)');
  host.send({ t: 'unkill' });
  panelWs.send({ t: 'key', n: 3, z: 1 });
  panelWs.send({ t: 'key', n: 3, z: 0 });
  await waitFor('rearmed', async () => {
    const s = (await panelState()).device;
    return s.armed && !s.killed;
  });

  host.send({ t: 'config', patch: { controlDurationMs: 10000 } });
  host.send({ t: 'open' });
  await waitFor('reopened', () => host.last('state')?.state.state === 'OPEN');
  for (const p of people) {
    p.clear();
    p.send({ t: 'enter' });
  }
  await waitFor('entrants back', () => host.last('state')?.state.entrants >= 2);
  host.send({ t: 'draw', countdownMs: 300 });
  await waitFor('second winner', () => people.some((p) => p.last('won')));
  const winner2 = people.find((p) => p.last('won'));
  check('the previous winner is excluded when re-winning is off', winner2 !== winner, `${winner2.pseudo} vs ${winner.pseudo}`);

  const grant2 = winner2.last('won');
  const activatedAt = Date.now();
  winner2.send({ t: 'activate', grantToken: grant2.grantToken });
  await waitFor('second pad active', () => winner2.last('active'));
  const endFrame = await waitFor('expiry', () => winner2.last('ended'), { timeout: 14000, interval: 50 });
  const elapsed = Date.now() - activatedAt;
  check('control stops on its own at the configured second', endFrame.reason === 'expired', `reason=${endFrame.reason}`);
  check('duration honoured within 500 ms', Math.abs(elapsed - 10000) < 500, `${elapsed} ms for a 10 000 ms window`);

  winner2.clear();
  winner2.send({ t: 'xy', grantToken: grant2.grantToken, x: 0.8, y: 0.8, seq: 999, ts: Date.now() });
  const afterExpiry = await waitFor('post-expiry refusal', () => winner2.last('error'));
  check('the token is dead after expiry', ['expired', 'not_authorised'].includes(afterExpiry.code), afterExpiry.code);

  // --- 8. disconnection ----------------------------------------------------
  section('8 · safe behaviour on disconnection (FR-13, §16)');
  await waitFor('reopened after expiry', () => host.last('state')?.state.state === 'OPEN', { timeout: 8000 });
  host.send({ t: 'config', patch: { controlDurationMs: 30000, disconnectGraceMs: 1000 } });
  for (const p of people) p.send({ t: 'enter' });
  await sleep(250);
  host.send({ t: 'draw', countdownMs: 300 });
  const winner3 = await waitFor('third winner', () => {
    for (const p of people) {
      const won = p.last('won');
      if (won && won.grantId !== grant2.grantId && won.grantId !== wonFrame.grantId) return p;
    }
    return null;
  });
  winner3.send({ t: 'activate', grantToken: winner3.last('won').grantToken });
  await waitFor('third pad active', () => winner3.last('active'));
  winner3.close(); // phone leaves the venue
  const ended = await waitFor(
    'grant dropped after the grace window',
    () => {
      const s = host.last('state')?.state;
      return s && (s.state === 'ENDED' || s.state === 'OPEN') && s.endReason !== 'expired' ? s : null;
    },
    { timeout: 8000, interval: 50 },
  );
  check('a disconnected winner loses control', ['disconnected', null].includes(ended.endReason ?? null), `endReason=${ended.endReason}`);
  await waitFor(
    'safe values after disconnection',
    async () => {
      const s = (await panelState()).device;
      return s.ccX === cfg.macros.x.safe && s.ccY === cfg.macros.y.safe;
    },
    { timeout: 6000, interval: 50 },
  );
  check('output back to safe after a dropped phone', true);

  // --- tidy up -------------------------------------------------------------
  section('9 · leave the stack usable');
  host.send({ t: 'reset' });
  host.send({ t: 'config', patch: { controlDurationMs: 30000, disconnectGraceMs: 3000 } });
  host.send({ t: 'open' });
  await waitFor('session reopened', () => host.last('state')?.state.state === 'OPEN');
  check('session reset and reopened for the next run', true);

  for (const p of people) p.close();
  host.close();
  panelWs.close();
}

main()
  .then(() => {
    console.log(`\n\x1b[1m${passed} checks passed, ${failures.length} failed\x1b[0m`);
    if (failures.length) {
      for (const f of failures) console.log(`  \x1b[31m·\x1b[0m ${f}`);
      process.exit(1);
    }
    console.log('\x1b[32mMVP acceptance criteria satisfied.\x1b[0m\n');
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n\x1b[31mAborted:\x1b[0m ${err.message}`);
    console.log(`${passed} checks passed before the abort, ${failures.length} failed`);
    process.exit(1);
  });
