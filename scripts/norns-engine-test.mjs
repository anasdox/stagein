#!/usr/bin/env node
/**
 * What the engine does, not what it looks like.
 *
 * `norns:check` proves the bundle boots and emits; `norns:bridge-test` proves the
 * transport carries frames. Neither exercises the decisions the engine makes when
 * the relay talks to it, which is where the musically audible behaviour lives.
 * This drives the real engine.lua in a real Lua interpreter, feeds it the frames
 * a relay sends, and reads back the MIDI, the outgoing patches and the screen.
 *
 * It proves the contract the device is built on: the relay owns every musical
 * value, the device only asks. So a config the relay confirms must land in the
 * params (or an encoder next moves from a stale position), an edit must leave as
 * one patch however fast the encoder turns (the relay drops the overflow without
 * a word), a remapped CC must not be abandoned mid-value, and an edit with no
 * relay to ask must say so instead of pretending.
 *
 * Needs neither hardware nor a relay.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'packages', 'norns-sim', 'package.json'));

let passed = 0;
const failures = [];

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the frames a relay sends ----------------------------------------------

/** Mirror of PRESETS in packages/protocol/src/session.ts. */
const MACROS = {
  'filter+delay': {
    x: { name: 'Filter', cc: 74, min: 30, max: 100, safe: 64, osc: '/stagein/filter' },
    y: { name: 'Delay', cc: 91, min: 0, max: 70, safe: 10, osc: '/stagein/delay' },
  },
  'texture+space': {
    x: { name: 'Texture', cc: 71, min: 20, max: 110, safe: 50, osc: '/stagein/texture' },
    y: { name: 'Space', cc: 93, min: 0, max: 90, safe: 8, osc: '/stagein/space' },
  },
};

function config(preset, { durationMs = 30_000, channel = 1 } = {}) {
  const macro = (axis) => ({ ...MACROS[preset][axis], channel, invert: false });
  return {
    controlDurationMs: durationMs,
    slewMs: 250,
    maxRatePerSec: 2,
    endBehavior: 'return-safe',
    preset,
    macros: { x: macro('x'), y: macro('y') },
  };
}

const sessionState = (over = {}) => ({
  sessionId: 'TEST01',
  state: 'OPEN',
  entrants: 7,
  connected: 9,
  winnerPseudo: null,
  remainingMs: null,
  countdownMs: null,
  ...over,
});

async function main() {
  console.log('StageIn — Norns engine behaviour');

  const { LuaNorns } = require(join(ROOT, 'packages', 'norns-sim', 'dist', 'lua-host.js'));

  const cc = [];
  const sent = [];
  const logs = [];
  let screenText = [];

  const norns = new LuaNorns(
    {
      log: (level, message) => logs.push(`${level}: ${message}`),
      screen: (frame) => {
        screenText = frame.ops.filter((o) => o.op === 'text').map((o) => o.s ?? '');
      },
      midiCc: (channel, controller, value) => cc.push({ channel, controller, value }),
      osc: () => {},
      wsSend: (payload) => {
        try {
          sent.push(JSON.parse(payload));
        } catch {
          /* not our problem here */
        }
      },
    },
    {
      armMode: 'latch',
      midiBackend: 'midi',
      tickMs: 5,
      scriptDir: join(ROOT, 'packages', 'norns-script', 'lib'),
      harnessDir: join(ROOT, 'packages', 'norns-sim', 'lua'),
    },
  );

  const patches = () => sent.filter((f) => f.t === 'config').map((f) => f.patch);
  const clear = () => {
    cc.length = 0;
    sent.length = 0;
  };
  const send = (frame) => norns.relayMessage(JSON.stringify(frame));
  /** Long enough to outlast the patch rest window and the post-edit grace. */
  const settle = () => sleep(800);

  try {
    await norns.boot();
    norns.relayOpen();
    send({ t: 'welcome', sessionId: 'TEST01', config: config('filter+delay'), state: sessionState() });
    await settle();

    // --- 1 -----------------------------------------------------------------
    section('1 · the lottery count is on the screen');
    check('an open lottery says how many are in it', screenText.includes('7 in the draw'), screenText.join(' | ').slice(0, 90));
    send({ t: 'state', state: sessionState({ entrants: 12 }) });
    await sleep(200);
    check('and it follows the relay', screenText.includes('12 in the draw'));
    send({ t: 'state', state: sessionState({ state: 'DRAWING', entrants: 12, countdownMs: 5000 }) });
    await sleep(200);
    check(
      'the count stays up while the draw fires',
      screenText.some((t) => t.startsWith('drawing') && t.includes('12 in')),
      screenText.find((t) => t.startsWith('drawing')) ?? '',
    );
    send({ t: 'state', state: sessionState({ state: 'ACTIVE', entrants: 12 }) });
    await sleep(200);

    // --- 2 -----------------------------------------------------------------
    section('2 · a remapped CC is not abandoned mid-value');
    clear();
    // Every preset moves at least one CC: x 74 -> 71, y 91 -> 93.
    send({ t: 'config', config: config('texture+space', { durationMs: 45_000, channel: 5 }) });
    await settle();
    const parkedX = cc.filter((m) => m.controller === 74);
    const parkedY = cc.filter((m) => m.controller === 91);
    check(
      'the CC left behind is parked on the safe value',
      parkedX.length === 1 && parkedX[0].value === 64 && parkedY.length === 1 && parkedY[0].value === 10,
      `CC74=${parkedX.map((m) => m.value)} CC91=${parkedY.map((m) => m.value)}`,
    );
    check(
      'and the new CC is stated without waiting for a movement',
      cc.some((m) => m.controller === 71) && cc.some((m) => m.controller === 93),
      `CC71 ${cc.filter((m) => m.controller === 71).length}× · CC93 ${cc.filter((m) => m.controller === 93).length}×`,
    );
    check(
      'the channel the relay chose is the channel on the wire',
      cc.filter((m) => m.controller === 71 || m.controller === 93).every((m) => m.channel === 5),
      'channel 5',
    );

    // --- 3 -----------------------------------------------------------------
    section('3 · a confirmed config lands in the params');
    clear();
    norns.enc(1, -1); // preset: one back from what the relay just confirmed
    await settle();
    check(
      'an encoder moves from the relay\'s value, not from a stale one',
      patches().length === 1 && patches()[0].preset === 'filter+reverb',
      `preset=${patches()[0]?.preset ?? 'nothing sent'} (stale would say filter+delay)`,
    );
    clear();
    norns.enc(2, 1); // duration: the relay said 45 s
    await settle();
    check(
      'and the same holds for a value only the relay knows',
      patches().length === 1 && patches()[0].controlDurationMs === 46_000,
      `${patches()[0]?.controlDurationMs ?? 'nothing sent'} ms (stale would say 31000)`,
    );

    // --- 4 -----------------------------------------------------------------
    section('4 · one gesture is one patch');
    clear();
    for (let i = 0; i < 12; i++) norns.enc(3, -1); // a spun encoder, 12 detents
    await settle();
    check(
      '12 detents leave as a single patch',
      patches().length === 1,
      `${patches().length} patch(es) — the relay drops what overflows its 20/s bucket, silently`,
    );
    check(
      'carrying where the encoder came to rest',
      norns.deviceState().intensity === 88,
      `intensity=${norns.deviceState().intensity}%`,
    );

    // --- 5 -----------------------------------------------------------------
    section('5 · with no relay to ask, an edit says so');
    norns.relayClose();
    clear();
    for (let i = 0; i < 3; i++) norns.enc(3, -1);
    await sleep(500);
    check('nothing is sent into the void', patches().length === 0, `${patches().length} patch(es)`);
    check(
      'the param goes back to the value in force',
      norns.deviceState().intensity === 100,
      `intensity=${norns.deviceState().intensity}% (the edit did not stick)`,
    );
    check(
      'and the screen says why',
      screenText.some((t) => t.includes('not applied')),
      screenText.find((t) => t.includes('not applied')) ?? `no notice among: ${screenText.join(' | ').slice(0, 80)}`,
    );
  } finally {
    norns.shutdown();
  }

  const errors = logs.filter((l) => l.startsWith('error'));
  section('6 · nothing threw along the way');
  check('no error logged', errors.length === 0, errors.slice(0, 3).join(' | '));
}

main()
  .then(() => {
    console.log(`\n\x1b[1m${passed} checks passed, ${failures.length} failed\x1b[0m`);
    if (failures.length) {
      for (const f of failures) console.log(`  \x1b[31m·\x1b[0m ${f}`);
      process.exit(1);
    }
    console.log('\x1b[32mThe engine behaves.\x1b[0m\n');
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n\x1b[31mAborted:\x1b[0m ${err.stack ?? err.message}`);
    console.log(`${passed} checks passed before the abort`);
    process.exit(1);
  });
