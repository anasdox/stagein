#!/usr/bin/env node
/**
 * A scripted performance, for showing StageIn to somebody.
 *
 * Plays the whole ritual against a running stack: registrations open, an
 * audience joins, the device is armed, one person is drawn, they play the pad,
 * and the kill switch cuts it. Narrates each beat and draws the Norns screen in
 * the terminal, so the demo reads even with no browser open.
 *
 *   mise run up      # in one terminal
 *   mise run demo    # in another — open the stage view and the panel first
 *
 * Options:
 *   --lead 15     seconds to wait before starting, to open the pages
 *   --no-kill     let the window expire on its own instead of cutting it
 */

const RELAY = (process.env.SMOKE_RELAY_URL || 'http://localhost:8080').replace(/\/+$/, '');
const PANEL = (process.env.SMOKE_PANEL_URL || 'http://localhost:8081').replace(/\/+$/, '');
const SESSION = (process.env.BOOTSTRAP_SESSION_ID || 'DEMO01').toUpperCase();
const HOST_TOKEN = process.env.BOOTSTRAP_HOST_TOKEN || 'dev-host-token-change-me';

const argv = process.argv.slice(2);
const LEAD = Number(argv.includes('--lead') ? argv[argv.indexOf('--lead') + 1] : 0) || 0;
const USE_KILL = !argv.includes('--no-kill');

const ws = (path) => `${RELAY.replace(/^http/, 'ws')}${path}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AUDIENCE = ['Nova', 'Kilo', 'Mira', 'Zed', 'Ash', 'Wren'];

// --- presentation -----------------------------------------------------------

const DIM = '\x1b[90m';
const BOLD = '\x1b[1m';
const AMBER = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const OFF = '\x1b[0m';

let t0 = Date.now();
const stamp = () => `${DIM}${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s${OFF}`;

const beat = (text) => console.log(`\n${stamp()} ${BOLD}${text}${OFF}`);
const say = (text) => console.log(`${stamp()} ${text}`);
const watch = (text) => console.log(`${stamp()} ${DIM}↳ ${text}${OFF}`);

/** A horizontal bar for a 0..127 CC value, drawn inside its authorised range. */
function bar(value, min, max, width = 28) {
  const span = Math.max(1, max - min);
  const filled = Math.round(((Math.max(min, Math.min(max, value)) - min) / span) * width);
  return `${'█'.repeat(filled)}${DIM}${'·'.repeat(width - filled)}${OFF}`;
}

// ---------------------------------------------------------------------------
// The Norns screen, drawn from the display list the Lua script emits.
// 128x64 pixels collapse to 64x16 characters.
// ---------------------------------------------------------------------------

function renderScreen(frame) {
  const COLS = 64;
  const ROWS = 16;
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(' '));

  const put = (col, row, char) => {
    if (row >= 0 && row < ROWS && col >= 0 && col < COLS && char !== ' ') grid[row][col] = char;
  };

  for (const op of frame.ops ?? []) {
    if (op.op === 'text') {
      // Baseline y sits at the bottom of the glyph, hence the -1 row.
      const row = Math.max(0, Math.round(op.y / 4) - 1);
      const text = String(op.s);
      let col = Math.round(op.x / 2);
      if (op.align === 'right') col -= text.length;
      else if (op.align === 'center') col -= Math.floor(text.length / 2);
      for (let i = 0; i < text.length; i++) put(col + i, row, text[i]);
    } else if (op.op === 'rect') {
      const left = Math.round(op.x / 2);
      const right = Math.round((op.x + op.w) / 2);
      const top = Math.round(op.y / 4);
      const bottom = Math.round((op.y + op.h) / 4);
      for (let c = left; c <= right; c++) {
        put(c, top, '─');
        put(c, bottom, '─');
      }
      for (let r = top; r <= bottom; r++) {
        put(left, r, '│');
        put(right, r, '│');
      }
    } else if (op.op === 'circle') {
      put(Math.round(op.x / 2), Math.max(0, Math.round(op.y / 4)), op.fill ? '◆' : 'o');
    } else if (op.op === 'line' && op.pts?.length > 1) {
      const [x1, y1] = op.pts[0];
      const [x2, y2] = op.pts[op.pts.length - 1];
      if (Math.abs(y2 - y1) < 2) {
        const row = Math.round(y1 / 4);
        for (let c = Math.round(x1 / 2); c <= Math.round(x2 / 2); c++) put(c, row, '─');
      }
    }
  }

  const edge = `${DIM}${'─'.repeat(COLS)}${OFF}`;
  console.log(`      ${DIM}┌${OFF}${edge}${DIM}┐${OFF}`);
  for (const row of grid) console.log(`      ${DIM}│${OFF}${row.join('')}${DIM}│${OFF}`);
  console.log(`      ${DIM}└${OFF}${edge}${DIM}┘${OFF}`);
}

// ---------------------------------------------------------------------------

class Socket {
  constructor(url) {
    this.frames = [];
    this.sock = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.sock.addEventListener('open', resolve);
      this.sock.addEventListener('error', () => reject(new Error(`cannot reach ${url}`)));
    });
    this.ready.catch(() => {});
    this.sock.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      this.frames.push(msg);
      if (msg.t === 'ping') this.send({ t: 'pong', id: msg.id, ts: Date.now() });
    });
  }
  send(msg) {
    if (this.sock.readyState === 1) this.sock.send(JSON.stringify(msg));
  }
  last(type) {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i].t === type) return this.frames[i];
    return null;
  }
  state() {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      if (f.t === 'state' || f.t === 'welcome') return f.state;
    }
    return null;
  }
  close() {
    try {
      this.sock.close();
    } catch {}
  }
}

async function waitFor(label, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await sleep(25);
  }
}

const device = async () => (await fetch(`${PANEL}/api/state`).then((r) => r.json())).device;

let lastScreen = null;

async function main() {
  console.log(`${BOLD}StageIn — démo${OFF}`);
  console.log(`${DIM}Le public entre temporairement dans la performance.${OFF}\n`);
  console.log(`  ${BOLD}À ouvrir pour regarder :${OFF}`);
  console.log(`    vue publique   ${AMBER}${RELAY}/stage/${SESSION}${OFF}`);
  console.log(`    écran du Norns ${AMBER}${PANEL}${OFF}`);
  console.log(`    console hôte   ${AMBER}${RELAY}/host/${SESSION}#t=${HOST_TOKEN}${OFF}`);

  // Keep the emulated screen in view: the panel pushes a frame on every redraw.
  const panel = new Socket(`${PANEL.replace(/^http/, 'ws')}/panel`);
  await panel.ready;
  panel.sock.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'screen') lastScreen = msg.frame;
  });

  const host = new Socket(ws(`/ws/host?session=${SESSION}`));
  await host.ready;
  host.send({ t: 'hello', hostToken: HOST_TOKEN });
  const welcome = await waitFor('host console', () => host.last('welcome'));
  const joinKey = new URL(welcome.state.joinUrl).searchParams.get('k');
  const cfg = welcome.state.config;

  if (LEAD > 0) {
    console.log(`\n${DIM}Départ dans ${LEAD}s — ouvrez les pages ci-dessus.${OFF}`);
    for (let i = LEAD; i > 0; i--) {
      process.stdout.write(`\r${DIM}  ${i}…${OFF}   `);
      await sleep(1000);
    }
    process.stdout.write('\r          \r');
  }

  t0 = Date.now();

  // --- 1. the room opens ---------------------------------------------------
  beat('1 · L\'hôte ouvre les inscriptions');
  host.send({ t: 'reset' });
  await waitFor('reset', () => host.state()?.state === 'CLOSED');
  host.send({ t: 'config', patch: { controlDurationMs: 30000, activationTimeoutMs: 10000 } });
  host.send({ t: 'open' });
  await waitFor('open', () => host.state()?.state === 'OPEN');
  say(`session ${BOLD}${SESSION}${OFF} ouverte · QR affiché sur la vue publique`);
  watch('la vue publique montre le QR code et « Scanne : entre en scène »');

  // --- 2. the device is armed ---------------------------------------------
  beat('2 · Le Norns est armé (K3)');
  let d = await device();
  if (d.killed || d.armed) {
    // Leave the device in a known state whatever the previous run did.
    panel.send({ t: 'key', n: 3, z: 1 });
    panel.send({ t: 'key', n: 3, z: 0 });
    await sleep(250);
    d = await device();
    if (d.killed) {
      panel.send({ t: 'key', n: 3, z: 1 });
      panel.send({ t: 'key', n: 3, z: 0 });
    }
  }
  if (!(await device()).armed) {
    panel.send({ t: 'key', n: 3, z: 1 });
    panel.send({ t: 'key', n: 3, z: 0 });
  }
  d = await waitFor('armed', async () => {
    const s = await device();
    return s.armed && !s.killed ? s : null;
  });
  say(`${GREEN}ARMED${OFF} — mais ${BOLD}rien ne passe encore${OFF} : aucune autorisation en cours`);
  watch(`sortie parquée sur la valeur sûre · CC${cfg.macros.x.cc}=${d.ccX} CC${cfg.macros.y.cc}=${d.ccY}`);

  // --- 3. the audience joins ----------------------------------------------
  beat('3 · Le public rejoint la loterie');
  const phones = [];
  for (const name of AUDIENCE) {
    const phone = new Socket(ws(`/ws/participant?session=${SESSION}&k=${joinKey}`));
    await phone.ready;
    phone.name = name;
    phone.id = `demo-${name.toLowerCase()}-${Math.random().toString(36).slice(2, 10)}`;
    phone.send({ t: 'hello', clientId: phone.id, pseudo: name });
    await waitFor(`${name} connecté`, () => phone.last('welcome'));
    phone.send({ t: 'enter' });
    phones.push(phone);
    await sleep(500); // people do not arrive all at once
    say(`${name} rejoint — ${BOLD}${host.state()?.entrants ?? 0}${OFF} inscrits`);
  }

  // --- 4. the draw --------------------------------------------------------
  beat('4 · Tirage au sort');
  for (const phone of phones) phone.frames.length = 0;
  host.send({ t: 'draw', countdownMs: 5000 });
  let shown = -1;
  await waitFor('gagnant', () => {
    const s = host.state();
    const left = s?.countdownMs;
    if (left != null) {
      const seconds = Math.ceil(left / 1000);
      if (seconds !== shown) {
        shown = seconds;
        say(`${AMBER}${seconds}${OFF}…`);
      }
    }
    return s?.state === 'AWARDED' ? s : null;
  });
  const winner = phones.find((p) => p.last('won'));
  const grant = winner.last('won');
  say(`${BOLD}${AMBER}${winner.name}${OFF} est tiré·e — son téléphone vibre`);
  watch(`les ${phones.length - 1} autres ne reçoivent aucun jeton`);
  watch(`${winner.name} a ${cfg.activationTimeoutMs / 1000}s pour prendre le contrôle`);

  // --- 5. the performance -------------------------------------------------
  beat('5 · Le pad est actif');
  winner.send({ t: 'activate', grantToken: grant.grantToken });
  const active = await waitFor('pad actif', () => winner.last('active'));
  say(`autorisation ouverte jusqu'à ${new Date(active.expiresAt).toISOString().slice(11, 19)}`);
  watch(`X = ${cfg.macros.x.name} (CC${cfg.macros.x.cc}, plage ${cfg.macros.x.min}–${cfg.macros.x.max})`);
  watch(`Y = ${cfg.macros.y.name} (CC${cfg.macros.y.cc}, plage ${cfg.macros.y.min}–${cfg.macros.y.max})`);
  console.log('');

  let seq = 0;
  const send = (x, y) =>
    winner.send({
      t: 'xy',
      grantToken: grant.grantToken,
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      seq: ++seq,
      ts: Date.now(),
    });

  /** A gesture, played for `ms`, sampled at the configured mobile rate. */
  async function gesture(label, ms, path) {
    say(`${DIM}geste :${OFF} ${label}`);
    const start = Date.now();
    let printed = 0;
    while (Date.now() - start < ms) {
      const k = (Date.now() - start) / ms;
      const { x, y } = path(k);
      send(x, y);
      // A readable trace, not every frame.
      if (Date.now() - start > printed * 900) {
        printed++;
        const s = await device();
        const left = host.state()?.remainingMs ?? 0;
        console.log(
          `        ${bar(s.ccX, cfg.macros.x.min, cfg.macros.x.max)} ${cfg.macros.x.name.padEnd(7)}${String(s.ccX).padStart(3)}` +
            `   ${bar(s.ccY, cfg.macros.y.min, cfg.macros.y.max)} ${cfg.macros.y.name.padEnd(7)}${String(s.ccY).padStart(3)}` +
            `   ${DIM}${(left / 1000).toFixed(0)}s${OFF}`,
        );
      }
      await sleep(1000 / cfg.rateHz);
    }
  }

  await gesture('le filtre s\'ouvre lentement', 6000, (k) => ({ x: k, y: 0.15 }));
  await gesture('le delay monte, le filtre respire', 7000, (k) => ({
    x: 0.7 + 0.3 * Math.sin(k * Math.PI * 3),
    y: k,
  }));
  await gesture('un cercle — les deux macros ensemble', 6000, (k) => ({
    x: 0.5 + 0.45 * Math.cos(k * Math.PI * 2),
    y: 0.5 + 0.45 * Math.sin(k * Math.PI * 2),
  }));

  console.log('');
  say(`écran du Norns pendant le contrôle :`);
  if (lastScreen) renderScreen(lastScreen);

  // --- 6. the artists take it back ----------------------------------------
  if (USE_KILL) {
    beat('6 · L\'arrêt d\'urgence');
    say('un geste extrême : le doigt part dans le coin');
    for (let i = 0; i < 8; i++) {
      send(1, 1);
      await sleep(1000 / cfg.rateHz);
    }
    const before = await device();
    say(`avant la coupure · CC${cfg.macros.x.cc}=${before.ccX} CC${cfg.macros.y.cc}=${before.ccY}`);

    const killAt = Date.now();
    host.send({ t: 'kill' });
    const killed = await waitFor('kill', async () => {
      const s = await device();
      return s.killed ? s : null;
    });
    say(`${RED}KILL${OFF} appliqué en ${BOLD}${Date.now() - killAt} ms${OFF}`);
    watch('le pad du gagnant se verrouille, les valeurs suivantes sont ignorées');
    void killed;

    say('retour progressif vers le preset sûr :');
    for (let i = 0; i < 6; i++) {
      const s = await device();
      console.log(
        `        ${bar(s.ccX, cfg.macros.x.min, cfg.macros.x.max)} ${cfg.macros.x.name.padEnd(7)}${String(s.ccX).padStart(3)}` +
          `   ${bar(s.ccY, cfg.macros.y.min, cfg.macros.y.max)} ${cfg.macros.y.name.padEnd(7)}${String(s.ccY).padStart(3)}`,
      );
      await sleep(220);
    }
    const settled = await waitFor(
      'valeurs sûres',
      async () => {
        const s = await device();
        return s.ccX === cfg.macros.x.safe && s.ccY === cfg.macros.y.safe ? s : null;
      },
      6000,
    );
    say(`${GREEN}valeurs sûres atteintes${OFF} · CC${cfg.macros.x.cc}=${settled.ccX} CC${cfg.macros.y.cc}=${settled.ccY}`);
    host.send({ t: 'unkill' });
  } else {
    beat('6 · La fenêtre se termine seule');
    const ended = await waitFor('fin', () => winner.last('ended'), 40000);
    say(`fin automatique · raison : ${BOLD}${ended.reason}${OFF}`);
  }

  // --- 7. and again -------------------------------------------------------
  beat('7 · Prêt pour le prochain tirage');
  const metrics = host.state()?.metrics;
  say(`latence geste → Norns · P50 ${metrics.latencyP50} ms · P95 ${BOLD}${metrics.latencyP95} ms${OFF} ${DIM}(cible < 250 ms)${OFF}`);
  say(`${metrics.eventsIn} événements reçus, ${metrics.eventsDropped} refusés par le relais`);
  const final = await device();
  say(`${final.accepted} images acceptées par le Norns, ${final.rejected} refusées`);

  host.send({ t: 'reset' });
  host.send({ t: 'open' });
  await waitFor('réouverture', () => host.state()?.state === 'OPEN');
  say(`session réouverte — le rituel peut recommencer`);

  for (const phone of phones) phone.close();
  host.close();
  panel.close();
  console.log(`\n${GREEN}Fin de la démo.${OFF}\n`);
}

main().catch((err) => {
  console.error(`\n${RED}La démo s'est arrêtée :${OFF} ${err.message}`);
  console.error(`${DIM}Le stack tourne-t-il ? mise run up${OFF}\n`);
  process.exit(1);
});
