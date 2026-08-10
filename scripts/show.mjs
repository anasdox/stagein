#!/usr/bin/env node
/**
 * Show-time helpers.
 *
 * One operator, no colleague to call, often mid-set with a laptop half-open.
 * Every command here is meant to be typed from memory and answer in seconds:
 *
 *   mise run show:preflight   go / no-go before doors
 *   mise run show:status      one glance, or --watch
 *   mise run show:qr          the join QR in the terminal
 *   mise run show:draw        fire the lottery
 *   mise run show:reopen      reset and reopen between draws
 *   mise run show:panic       emergency stop, without finding a browser tab
 *   mise run show:archive     keep the evidence after the set
 *   mise run show:secrets     generate real tokens
 *
 * Deliberately no daemon and no state of its own: each command connects, does
 * one thing, and exits. Nothing here can be the reason a show fails.
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'packages', 'relay', 'package.json'));

const RELAY = (process.env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const LOCAL = (process.env.LOCAL_RELAY_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/+$/, '');
const PANEL = (process.env.NORNS_PANEL_URL || `http://localhost:${process.env.NORNS_PORT || 8081}`).replace(/\/+$/, '');
const SESSION = (process.env.BOOTSTRAP_SESSION_ID || 'DEMO01').toUpperCase();
const HOST_TOKEN = process.env.BOOTSTRAP_HOST_TOKEN || 'dev-host-token-change-me';

const DEFAULT_HOST_TOKEN = 'dev-host-token-change-me';
const DEFAULT_NORNS_TOKEN = 'dev-norns-token-change-me';

const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const D = '\x1b[90m';
const B = '\x1b[1m';
const O = '\x1b[0m';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

/** Connect as host, run `fn` with the live state, disconnect. */
async function withHost(fn, { timeout = 8000 } = {}) {
  const ws = new WebSocket(`${LOCAL.replace(/^http/, 'ws')}/ws/host?session=${SESSION}`);
  const frames = [];
  const last = (t) => {
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i].t === t) return frames[i];
    return null;
  };
  const state = () => {
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      if (f.t === 'state' || f.t === 'welcome') return f.state;
    }
    return null;
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer from the relay at ${LOCAL}`)), timeout);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`cannot reach the relay at ${LOCAL} — is it running? (mise run show:start)`));
    });
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    frames.push(msg);
    if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', id: msg.id, ts: Date.now() }));
  });
  ws.send(JSON.stringify({ t: 'hello', hostToken: HOST_TOKEN }));

  const deadline = Date.now() + timeout;
  while (!state()) {
    if (last('error')) throw new Error(`the relay refused the host token: ${last('error').message}`);
    if (Date.now() > deadline) throw new Error('the relay never sent a state — wrong host token?');
    await sleep(25);
  }

  const send = (msg) => ws.send(JSON.stringify(msg));
  try {
    return await fn({ send, state, last, wait: async (pred, ms = 6000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (pred(state())) return state();
        await sleep(50);
      }
      throw new Error('the relay did not reach the expected state in time');
    } });
  } finally {
    ws.close();
  }
}

const lanAddresses = () =>
  Object.entries(networkInterfaces()).flatMap(([name, addrs]) =>
    (addrs ?? [])
      .filter((a) => a.family === 'IPv4' && !a.internal)
      .map((a) => ({ name, address: a.address })),
  );

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

async function preflight() {
  let failures = 0;
  let warnings = 0;

  const ok = (label, detail = '') => console.log(`  ${G}ok  ${O} ${label}${detail ? ` ${D}${detail}${O}` : ''}`);
  const warn = (label, detail = '') => {
    warnings++;
    console.log(`  ${Y}warn${O} ${label}${detail ? ` ${D}${detail}${O}` : ''}`);
  };
  const fail = (label, detail = '') => {
    failures++;
    console.log(`  ${R}STOP${O} ${label}${detail ? ` ${D}${detail}${O}` : ''}`);
  };

  console.log(`${B}StageIn — preflight${O}`);
  console.log(`${D}session ${SESSION} · public ${RELAY}${O}\n`);

  // --- 1. the address printed on the QR ------------------------------------
  console.log(`${B}1 · reachability${O}`);
  const publicHost = new URL(RELAY).hostname;
  if (['localhost', '127.0.0.1', '::1'].includes(publicHost)) {
    fail(
      'PUBLIC_BASE_URL points at localhost',
      'phones cannot resolve it — the QR leads nowhere. Set it to a LAN address.',
    );
    for (const { name, address } of lanAddresses()) {
      console.log(`         ${D}candidate: PUBLIC_BASE_URL=http://${address}:${process.env.PORT || 8080}  (${name})${O}`);
    }
  } else {
    const local = lanAddresses().some((a) => a.address === publicHost);
    if (local || !/^\d+\.\d+\.\d+\.\d+$/.test(publicHost)) ok('PUBLIC_BASE_URL is not localhost', RELAY);
    else warn('PUBLIC_BASE_URL is an IP this machine does not hold', `${publicHost} — behind a proxy or tunnel?`);
  }

  let health = null;
  try {
    health = await fetch(`${LOCAL}/healthz`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
    ok('relay is up', `${health.sessions} session(s), ${health.norns} norns, up ${health.uptimeSec}s`);
  } catch {
    fail('relay is not answering', `${LOCAL} — start it with: mise run show:start`);
  }

  if (health) {
    // The join page must actually serve on the address the QR carries.
    try {
      const res = await fetch(`${RELAY}/j/${SESSION}`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) ok('the join page serves on the public address', `${RELAY}/j/${SESSION}`);
      else fail('the join page does not serve on the public address', `HTTP ${res.status}`);
    } catch (err) {
      fail('the public address is unreachable from this machine', String(err.message ?? err));
    }
  }

  // --- 2. secrets ----------------------------------------------------------
  console.log(`\n${B}2 · secrets${O}`);
  if (HOST_TOKEN === DEFAULT_HOST_TOKEN) {
    fail('the host token is the shipped default', 'anyone who guesses it can drive the show — mise run show:secrets');
  } else ok('host token has been changed');
  if ((process.env.BOOTSTRAP_NORNS_TOKEN || DEFAULT_NORNS_TOKEN) === DEFAULT_NORNS_TOKEN) {
    fail('the norns token is the shipped default', 'mise run show:secrets');
  } else ok('norns token has been changed');

  // --- 3. the session and the device ---------------------------------------
  console.log(`\n${B}3 · session and device${O}`);
  if (!health) {
    console.log(`  ${D}skipped — the relay is down${O}`);
  } else {
    try {
      await withHost(async ({ state }) => {
        const s = state();
        ok('host console reachable with this token', `state ${s.state}`);

        if (s.killed) fail('a kill is still active', 'nothing will pass — clear it before doors');
        else ok('no kill latched');

        if (!s.nornsOnline) fail('the Norns is not connected', 'check the bridge: mise run norns:logs');
        else ok('Norns is connected');

        if (s.nornsOnline && !s.nornsArmed) {
          warn('the Norns is not armed', 'nothing reaches the output until K3 — arm it before the first draw');
        } else if (s.nornsArmed) ok('Norns is armed');

        if (s.norns) {
          ok('output backend', `${s.norns.midiBackend} · ${s.macroNames.x} CC${s.config.macros.x.cc} · ${s.macroNames.y} CC${s.config.macros.y.cc}`);
          if (s.norns.midiBackend === 'log') {
            warn('the Norns is only logging MIDI', 'no sound will come out — set MIDI_BACKEND=midi on the device');
          }
        }

        // Which of matron's sixteen virtual ports the CC leaves through. A port
        // with nothing behind it accepts every value and drops it, so this is
        // total silence for the whole set, and no ritual step recovers it.
        if (s.nornsOnline && s.norns && s.norns.midiBackend !== 'osc') {
          const port = s.norns.midiPort;
          if (!port) {
            warn(
              'the Norns has not reported a MIDI port',
              'either it just connected, or its script predates this check — mise run norns:deploy',
            );
          } else if (!port.live) {
            fail(
              `nothing is behind MIDI port ${port.index} (${port.name})`,
              'every CC is accepted and thrown away — pick a mapped port in PARAMS > midi out, or map one in SYSTEM > DEVICES > MIDI',
            );
          } else {
            ok('MIDI port has a device behind it', `${port.index} ${port.name}`);
          }
        }

        if (['ACTIVE', 'AWARDED', 'DRAWING'].includes(s.state)) {
          warn(`the session is mid-ritual (${s.state})`, 'run mise run show:reopen to start clean');
        } else ok('session is idle and ready', s.state);

        const m = s.metrics;
        if (m.latencyP95 != null) {
          if (m.latencyP95 < 250) ok('latency within budget', `P95 ${Math.round(m.latencyP95)} ms via ${m.latencySource}`);
          else warn('latency above the 250 ms budget', `P95 ${Math.round(m.latencyP95)} ms`);
        } else warn('no latency measured yet', 'it appears once somebody plays the pad');

        ok('names on the public view', s.namesHidden ? 'hidden' : 'shown');
      });
    } catch (err) {
      fail('host console check failed', String(err.message ?? err));
    }
  }

  // --- verdict -------------------------------------------------------------
  console.log('');
  if (failures > 0) {
    console.log(`${R}${B}NO-GO${O} — ${failures} blocking, ${warnings} to look at.`);
    process.exit(1);
  }
  if (warnings > 0) console.log(`${Y}${B}GO, with ${warnings} thing(s) to look at.${O}`);
  else console.log(`${G}${B}GO.${O}`);
  console.log(`${D}Show the QR with: mise run show:qr${O}\n`);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function statusLine(s) {
  const arm = s.killed ? `${R}KILLED${O}` : s.nornsArmed ? `${G}ARMED${O}` : `${Y}idle${O}`;
  const norns = s.nornsOnline ? arm : `${R}norns OFFLINE${O}`;
  const timer =
    s.state === 'DRAWING' && s.countdownMs != null
      ? `draw in ${Math.ceil(s.countdownMs / 1000)}s`
      : s.remainingMs != null
        ? `${Math.ceil(s.remainingMs / 1000)}s left`
        : '';
  const cc = s.norns ? `CC${s.config.macros.x.cc}=${String(s.norns.ccX).padStart(3)} CC${s.config.macros.y.cc}=${String(s.norns.ccY).padStart(3)}` : '';
  // The same words the device screen uses: the CC values below are real, and
  // they are going nowhere. Worth shouting about mid-set, when someone has just
  // unplugged the interface.
  const dead = s.nornsOnline && s.norns && s.norns.midiPort && !s.norns.midiPort.live ? `${R}NO MIDI OUT${O}` : '';
  const p95 = s.metrics.latencyP95 != null ? `p95 ${Math.round(s.metrics.latencyP95)}ms` : '';
  return [
    `${B}${s.state.padEnd(8)}${O}`,
    `${String(s.entrants).padStart(3)} in / ${String(s.connected).padStart(3)} online`,
    norns,
    dead,
    s.winnerPseudo ? `${Y}${s.winnerPseudo}${O}` : '',
    timer,
    cc,
    p95,
  ]
    .filter(Boolean)
    .join('  ');
}

async function status(watch) {
  if (!watch) {
    await withHost(async ({ state }) => console.log(statusLine(state())));
    return;
  }
  console.log(`${D}Ctrl-C to stop${O}`);
  await withHost(async ({ state }) => {
    for (;;) {
      process.stdout.write(`\r\x1b[2K${statusLine(state())}`);
      await sleep(400);
    }
  });
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

async function panic() {
  await withHost(async ({ send, wait }) => {
    const at = Date.now();
    send({ t: 'kill' });
    await wait((s) => s.killed, 4000);
    console.log(`${R}${B}KILL sent${O} in ${Date.now() - at} ms. Nothing more reaches the rig.`);
    console.log(`${D}Clear it with: mise run show:reopen${O}`);
  });
}

async function reopen() {
  await withHost(async ({ send, state, wait }) => {
    if (state().killed) send({ t: 'unkill' });
    send({ t: 'reset' });
    send({ t: 'open' });
    const s = await wait((v) => v.state === 'OPEN', 6000);
    console.log(`${G}Registrations open.${O} ${statusLine(s)}`);
    if (!s.nornsArmed) console.log(`${Y}The Norns is not armed — press K3 before drawing.${O}`);
  });
}

async function draw(seconds) {
  await withHost(async ({ send, state, wait }) => {
    const s = state();
    if (s.state !== 'OPEN') throw new Error(`cannot draw from ${s.state} — run: mise run show:reopen`);
    if (s.entrants === 0) throw new Error('nobody is in the lottery yet');
    if (!s.nornsArmed) console.log(`${Y}Warning: the Norns is not armed, the winner will move nothing.${O}`);
    send({ t: 'draw', countdownMs: seconds * 1000 });
    const awarded = await wait((v) => v.state === 'AWARDED', seconds * 1000 + 6000);
    console.log(`${B}${awarded.winnerPseudo}${O} is on stage.`);
  });
}

async function qr() {
  const QRCode = require('qrcode');
  await withHost(async ({ state }) => {
    const url = state().joinUrl;
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    console.log(`  ${B}${url}${O}`);
    if (url.includes('localhost')) {
      console.log(`  ${R}This QR points at localhost — no phone can use it.${O}`);
      console.log(`  ${D}Set PUBLIC_BASE_URL and restart: mise run show:start${O}`);
    }
  });
}

// ---------------------------------------------------------------------------
// housekeeping
// ---------------------------------------------------------------------------

function secrets() {
  const envPath = join(ROOT, '.env');
  const token = () => randomBytes(24).toString('base64url');
  const values = { BOOTSTRAP_HOST_TOKEN: token(), BOOTSTRAP_NORNS_TOKEN: token() };

  let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(join(ROOT, '.env.example'), 'utf8');
  if (existsSync(envPath)) {
    copyFileSync(envPath, `${envPath}.bak`);
    console.log(`${D}previous .env kept as .env.bak${O}`);
  }
  for (const [key, value] of Object.entries(values)) {
    text = new RegExp(`^${key}=.*$`, 'm').test(text)
      ? text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
      : `${text.trimEnd()}\n${key}=${value}\n`;
  }
  writeFileSync(envPath, text);

  console.log(`${G}New tokens written to .env${O}`);
  for (const [key, value] of Object.entries(values)) console.log(`  ${key}=${value}`);
  console.log(`\n${B}Two things follow:${O}`);
  console.log('  1. restart the stack so it picks them up:  mise run show:start');
  console.log('  2. put the new norns token on the device:  mise run norns:config');
}

function archive() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(ROOT, 'archive', stamp);
  mkdirSync(dir, { recursive: true });

  /** Never write a command's error text into an artifact: it would be counted
   *  and reported as if it were data. Captures either succeed or say so. */
  const capture = (name, args) => {
    try {
      const out = execFileSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      writeFileSync(join(dir, name), out);
      return { ok: true, text: out };
    } catch (err) {
      const reason = (err.stderr?.toString() || err.message || 'unknown').trim().split('\n')[0];
      writeFileSync(join(dir, `${name}.MISSING`), `capture failed: ${reason}\n`);
      return { ok: false, reason };
    }
  };

  const results = {
    'relay.log': capture('relay.log', ['compose', 'logs', '--no-color', 'relay']),
    'norns.log': capture('norns.log', ['compose', 'logs', '--no-color', 'norns']),
    'midi.jsonl': capture('midi.jsonl', ['compose', 'exec', '-T', 'norns', 'cat', '/data/midi.jsonl']),
  };

  console.log(`${B}Archived to${O} archive/${stamp}`);
  let missing = 0;
  for (const [name, result] of Object.entries(results)) {
    if (!result.ok) {
      missing++;
      console.log(`  ${R}missing${O} ${name} ${D}${result.reason}${O}`);
      continue;
    }
    if (name === 'midi.jsonl') {
      // Count real messages, not lines: a partial or empty capture must not
      // read as a successful one.
      const messages = result.text
        .split('\n')
        .filter(Boolean)
        .filter((line) => {
          try {
            return typeof JSON.parse(line).cc === 'number';
          } catch {
            return false;
          }
        });
      console.log(`  ${G}saved  ${O} ${name} ${D}${messages.length} MIDI messages${O}`);
    } else {
      console.log(`  ${G}saved  ${O} ${name} ${D}${result.text.split('\n').length} lines${O}`);
    }
  }

  if (missing > 0) {
    console.log(`\n${Y}${missing} artifact(s) could not be captured.${O} Is the stack still up? Archive before ${B}show:stop${O}.`);
    process.exitCode = 1;
  } else {
    console.log(`${D}This is what proves what the rig was sent, after the fact.${O}`);
  }
}

// ---------------------------------------------------------------------------

const COMMANDS = {
  preflight,
  status: () => status(process.argv.includes('--watch')),
  panic,
  reopen,
  draw: () => {
    const idx = process.argv.indexOf('--in');
    const seconds = idx > 0 ? Number(process.argv[idx + 1]) : 5;
    return draw(Number.isFinite(seconds) ? Math.max(0, Math.min(60, seconds)) : 5);
  },
  qr,
  secrets: async () => secrets(),
  archive: async () => archive(),
};

const command = process.argv[2];
if (!command || !COMMANDS[command]) {
  console.error(`usage: show.mjs <${Object.keys(COMMANDS).join('|')}>`);
  process.exit(2);
}

COMMANDS[command]().catch((err) => {
  console.error(`${R}${err.message ?? err}${O}`);
  process.exit(1);
});
