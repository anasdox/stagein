#!/usr/bin/env node
/**
 * Prove the device transport without a device.
 *
 * On hardware the chain is:  engine --OSC--> bridge --WS--> relay
 * The simulator skips the middle hop, so nothing else exercises the bridge or
 * lib/relay_osc.lua's wire format. This test stands in for matron: it speaks the
 * same OSC the Lua transport speaks, runs the real python3 bridge, and points it
 * at the real relay.
 *
 * What is still unproven afterwards, and only hardware can settle: matron's own
 * osc.event delivery, `include()` path resolution, real MIDI ports, and whether
 * python3 exists on that particular Norns image — which is why `norns:deploy`
 * preflights the last one over ssh.
 *
 * Requires a running relay:  mise run up
 */

import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELAY = (process.env.SMOKE_RELAY_URL || 'http://localhost:8080').replace(/\/+$/, '');
const MATRON_PORT = Number(process.env.TEST_MATRON_PORT || 10141);
const BRIDGE_PORT = Number(process.env.TEST_BRIDGE_PORT || 10142);

let passed = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`);
  }
}

const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

// ---------------------------------------------------------------------------
// OSC — the same subset lib/relay_osc.lua uses: one address, one string arg
// ---------------------------------------------------------------------------

const pad = (buf) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)]);

function oscEncode(address, argument) {
  return Buffer.concat([
    pad(Buffer.concat([Buffer.from(address, 'utf8'), Buffer.alloc(1)])),
    pad(Buffer.concat([Buffer.from(',s', 'utf8'), Buffer.alloc(1)])),
    pad(Buffer.concat([Buffer.from(argument, 'utf8'), Buffer.alloc(1)])),
  ]);
}

function readOscString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const text = buf.subarray(offset, end).toString('utf8');
  return [text, offset + (Math.floor((end - offset) / 4) + 1) * 4];
}

function oscDecode(buf) {
  const [address, afterAddress] = readOscString(buf, 0);
  let offset = afterAddress;
  const args = [];
  if (offset < buf.length && buf[offset] === 0x2c) {
    const [tags, afterTags] = readOscString(buf, offset);
    offset = afterTags;
    for (const tag of tags.slice(1)) {
      if (tag === 's') {
        const [value, next] = readOscString(buf, offset);
        args.push(value);
        offset = next;
      }
    }
  }
  return { address, args };
}

// ---------------------------------------------------------------------------

async function waitFor(label, predicate, { timeout = 10000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

async function main() {
  console.log('StageIn — Norns bridge transport test');
  console.log(`relay ${RELAY} · fake matron on ${MATRON_PORT} · bridge on ${BRIDGE_PORT}`);

  // A dedicated session, so this never disturbs the demo one or fights the
  // simulator for the single Norns slot.
  const response = await fetch(`${RELAY}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const created = await response.json();
  if (!response.ok) {
    // Say which door is shut rather than timing out on the bridge later.
    throw new Error(
      created.error === 'session_creation_disabled'
        ? 'the relay refuses to create sessions (ALLOW_PUBLIC_SESSION_CREATE=false). Set it to true for this test.'
        : `could not create a test session: HTTP ${response.status} ${created.error ?? ''}`,
    );
  }
  console.log(`test session ${created.sessionId}`);

  // --- stand in for matron ------------------------------------------------
  const received = [];
  const matron = createSocket('udp4');
  matron.on('message', (data) => {
    try {
      received.push(oscDecode(data));
    } catch {
      /* ignore malformed */
    }
  });
  await new Promise((resolve) => matron.bind(MATRON_PORT, '127.0.0.1', resolve));

  const configDir = mkdtempSync(join(tmpdir(), 'stagein-bridge-'));
  const configPath = join(configDir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        relay_ws_url: `${RELAY.replace(/^http/, 'ws')}/ws/norns`,
        session: created.sessionId,
        norns_token: created.nornsToken,
        matron_osc_port: MATRON_PORT,
        bridge_osc_port: BRIDGE_PORT,
      },
      null,
      2,
    ),
  );

  const bridgeLog = [];
  const bridge = spawn(
    'python3',
    [join(ROOT, 'packages', 'norns-script', 'bridge', 'stagein_bridge.py'), '--config', configPath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  for (const stream of [bridge.stdout, bridge.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => bridgeLog.push(...chunk.split('\n').filter(Boolean)));
  }

  const frames = () =>
    received
      .filter((m) => m.address === '/stagein/in')
      .map((m) => {
        try {
          return JSON.parse(m.args[0]);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

  try {
    // --- 1. the bridge dials out and the engine hears about it -------------
    section('1 · bridge → relay → engine');
    await waitFor('bridge connect', () => bridgeLog.some((l) => l.includes('connected')));
    check('bridge opens the WebSocket', true, bridgeLog.find((l) => l.includes('connected')));
    await waitFor('link-up osc', () => received.some((m) => m.address === '/stagein/up'));
    check('engine is told the link is up', true, '/stagein/up');

    const welcome = await waitFor('welcome frame', () => frames().find((f) => f.t === 'welcome'));
    check('welcome arrives as OSC the Lua transport can decode', welcome.sessionId === created.sessionId, `session=${welcome.sessionId}`);
    check('welcome carries the session config', typeof welcome.config?.controlDurationMs === 'number', `duration=${welcome.config.controlDurationMs}ms preset=${welcome.config.preset}`);

    await waitFor('heartbeat', () => frames().some((f) => f.t === 'ping'), { timeout: 6000 });
    check('relay heartbeats reach the engine', true, 'ping frames flowing');

    // --- 2. engine → bridge → relay ---------------------------------------
    section('2 · engine → bridge → relay');
    const host = new WebSocket(`${RELAY.replace(/^http/, 'ws')}/ws/host?session=${created.sessionId}`);
    await new Promise((resolve, reject) => {
      host.addEventListener('open', resolve);
      host.addEventListener('error', () => reject(new Error('host socket failed')));
    });
    const hostFrames = [];
    host.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      hostFrames.push(msg);
      if (msg.t === 'ping') host.send(JSON.stringify({ t: 'pong', id: msg.id, ts: Date.now() }));
    });
    host.send(JSON.stringify({ t: 'hello', hostToken: created.hostToken }));
    await waitFor('host welcome', () => hostFrames.find((f) => f.t === 'welcome'));

    const lastHostState = () => {
      for (let i = hostFrames.length - 1; i >= 0; i--) {
        if (hostFrames[i].t === 'state' || hostFrames[i].t === 'welcome') return hostFrames[i].state;
      }
      return null;
    };
    check('relay reports the Norns online', lastHostState().nornsOnline === true);

    // Exactly the frame lib/relay_osc.lua would send from engine.lua.
    const status = {
      t: 'status',
      status: {
        armed: true,
        killed: false,
        preset: 'filter+delay',
        targetX: 0.25,
        targetY: 0.75,
        outX: 0.25,
        outY: 0.75,
        ccX: 47,
        ccY: 52,
        midiBackend: 'midi',
        lastMessageAt: Date.now(),
        rejected: 3,
      },
    };
    const engine = createSocket('udp4');
    await new Promise((resolve) => engine.bind(0, '127.0.0.1', resolve));
    const sendFromEngine = (obj) =>
      new Promise((resolve, reject) =>
        engine.send(oscEncode('/stagein/out', JSON.stringify(obj)), BRIDGE_PORT, '127.0.0.1', (err) =>
          err ? reject(err) : resolve(),
        ),
      );
    await sendFromEngine(status);

    const seen = await waitFor(
      'status reaches the relay',
      () => {
        const s = lastHostState();
        return s?.norns && s.norns.ccX === 47 && s.norns.ccY === 52 ? s : null;
      },
      { timeout: 6000 },
    );
    check('engine status crosses OSC → WS intact', seen.norns.ccX === 47 && seen.norns.ccY === 52, `CC ${seen.norns.ccX}/${seen.norns.ccY} rejected=${seen.norns.rejected}`);
    check('arm state propagates to the host console', seen.nornsArmed === true);

    // A device-side kill must reach the relay through the same path.
    await sendFromEngine({ t: 'kill' });
    const killed = await waitFor('kill reaches the relay', () => (lastHostState()?.killed ? lastHostState() : null), { timeout: 6000 });
    check('a device-side kill crosses the bridge', killed.killed === true);

    // --- 3. failure behaviour ---------------------------------------------
    section('3 · failure behaviour');
    bridge.kill('SIGTERM');
    const offline = await waitFor('relay notices', () => (lastHostState()?.nornsOnline === false ? lastHostState() : null), { timeout: 8000 });
    check('killing the bridge marks the Norns offline', offline.nornsOnline === false, 'host console shows it immediately');

    // A misconfigured token must refuse to start rather than hammer the relay.
    writeFileSync(
      configPath,
      JSON.stringify({
        relay_ws_url: `${RELAY.replace(/^http/, 'ws')}/ws/norns`,
        session: created.sessionId,
        norns_token: 'paste-the-norns-token-from-the-host-console',
        matron_osc_port: MATRON_PORT,
        bridge_osc_port: BRIDGE_PORT,
      }),
    );
    const refusing = spawn(
      'python3',
      [join(ROOT, 'packages', 'norns-script', 'bridge', 'stagein_bridge.py'), '--config', configPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let refusalLog = '';
    refusing.stdout.setEncoding('utf8');
    refusing.stdout.on('data', (c) => (refusalLog += c));
    const exitCode = await new Promise((resolve) => refusing.on('exit', resolve));
    check(
      'an unconfigured token refuses to start',
      exitCode === 0 && refusalLog.includes('REFUSING TO START'),
      refusalLog.trim().split('\n').pop() ?? '',
    );

    engine.close();
    host.close();
  } finally {
    bridge.kill('SIGKILL');
    matron.close();
  }
}

main()
  .then(() => {
    console.log(`\n\x1b[1m${passed} checks passed, ${failures.length} failed\x1b[0m`);
    if (failures.length) {
      for (const f of failures) console.log(`  \x1b[31m·\x1b[0m ${f}`);
      process.exit(1);
    }
    console.log('\x1b[32mDevice transport works end to end.\x1b[0m\n');
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n\x1b[31mAborted:\x1b[0m ${err.message}`);
    console.log(`${passed} checks passed before the abort`);
    process.exit(1);
  });
