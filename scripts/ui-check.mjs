#!/usr/bin/env node
/**
 * DOM coverage for the participant page.
 *
 * The acceptance suite drives WebSockets and never renders anything, which is
 * how the join page shipped blank: `show('idle')` was a no-op against a
 * pre-seeded `current`, so no screen ever became visible while every protocol
 * check passed. Frames arriving correctly says nothing about a screen appearing.
 *
 * So this loads the real join.html in a DOM, stubs only the browser edges the
 * page touches (WebSocket, localStorage, crypto, vibrate), feeds it the exact
 * frames the relay sends, and asserts on what a person would see.
 *
 * No relay and no containers needed:  mise run ui-check
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'packages', 'relay', 'public', 'join.html');

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
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Stands in for the relay: records what the page sends, injects what it receives. */
class FakeSocket {
  static latest = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    FakeSocket.latest = this;
    // The page attaches its handlers synchronously after construction.
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
  }
  /** Deliver a relay frame to the page. */
  deliver(frame) {
    const event = { data: JSON.stringify(frame) };
    this.onmessage?.(event);
    for (const fn of this.listeners.message ?? []) fn(event);
  }
  sentOf(type) {
    return this.sent.filter((m) => m.t === type);
  }
}

function publicState(overrides = {}) {
  return {
    sessionId: 'DEMO01',
    state: 'OPEN',
    entrants: 0,
    connected: 1,
    winnerPseudo: null,
    countdownMs: null,
    remainingMs: null,
    nornsOnline: true,
    nornsArmed: true,
    killed: false,
    namesHidden: false,
    preset: 'filter+delay',
    macroNames: { x: 'Filter', y: 'Delay' },
    endReason: null,
    ...overrides,
  };
}

async function load() {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (err) => errors.push(err.message));
  virtualConsole.on('error', (msg) => errors.push(String(msg)));

  const dom = new JSDOM(readFileSync(PAGE, 'utf8'), {
    url: 'http://localhost:8080/j/DEMO01?k=testkey',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.WebSocket = FakeSocket;
      window.navigator.vibrate = () => true;
      const store = new Map();
      Object.defineProperty(window, 'localStorage', {
        value: {
          getItem: (k) => store.get(k) ?? null,
          setItem: (k, v) => store.set(k, String(v)),
          removeItem: (k) => store.delete(k),
        },
      });
      // jsdom has no crypto.getRandomValues in this context.
      window.crypto.getRandomValues ??= (array) => {
        for (let i = 0; i < array.length; i++) array[i] = i * 7 + 1;
        return array;
      };
    },
  });

  await tick();
  await tick();
  return { dom, window: dom.window, doc: dom.window.document, errors };
}

/** Which screen a person is actually looking at. */
const activeScreen = (doc) => doc.querySelector('.screen[data-active]')?.dataset.screen ?? null;
const activeCount = (doc) => doc.querySelectorAll('.screen[data-active]').length;
const text = (doc, id) => doc.getElementById(id)?.textContent?.trim() ?? '';

async function main() {
  console.log('StageIn — participant page (DOM)');

  const { window, doc, errors } = await load();
  const socket = FakeSocket.latest;

  // --- 1. the page a spectator opens ---------------------------------------
  section('1 · the page renders something');
  check('no script errors while loading', errors.length === 0, errors[0] ?? '');
  check(
    'exactly one screen is visible on arrival',
    activeCount(doc) === 1,
    `${activeCount(doc)} active · "${activeScreen(doc)}"`,
  );
  check('it is the join screen', activeScreen(doc) === 'idle', `showing "${activeScreen(doc)}"`);
  check(
    'the way to register is present',
    Boolean(doc.getElementById('joinBtn')) && doc.getElementById('joinBtn').textContent.includes('Rejoindre'),
    `"${text(doc, 'joinBtn')}"`,
  );
  check('the name field is present', Boolean(doc.getElementById('pseudo')));

  // --- 2. the relay answers -------------------------------------------------
  section('2 · registration');
  check('the page announced itself', socket.sentOf('hello').length === 1, JSON.stringify(socket.sentOf('hello')[0]));

  socket.deliver({
    t: 'welcome',
    clientId: 'abc',
    pseudo: 'Comète 7',
    entered: false,
    state: publicState(),
  });
  await tick();

  check('the assigned stage name is filled in', doc.getElementById('pseudo').value === 'Comète 7', `"${doc.getElementById('pseudo').value}"`);
  check('the register button is enabled while registrations are open', doc.getElementById('joinBtn').disabled === false);
  check('still on the join screen', activeScreen(doc) === 'idle');

  doc.getElementById('joinBtn').dispatchEvent(new window.Event('click'));
  await tick();
  check('tapping it sends an entry request', socket.sentOf('enter').length === 1);
  check('and moves to the waiting screen', activeScreen(doc) === 'waiting', `showing "${activeScreen(doc)}"`);
  check('which shows the name that will be announced', text(doc, 'wPseudo') === 'Comète 7', `"${text(doc, 'wPseudo')}"`);

  socket.deliver({ t: 'entry', entered: true });
  socket.deliver({ t: 'state', state: publicState({ entrants: 1 }) });
  await tick();
  check('the entrant count is shown', text(doc, 'wCount') === '1', `"${text(doc, 'wCount')}"`);

  // --- 3. the relay disagreeing --------------------------------------------
  section('3 · the relay is the authority');
  socket.deliver({ t: 'entry', entered: false });
  socket.deliver({ t: 'state', state: publicState({ state: 'CLOSED', entrants: 0 }) });
  await tick();
  check(
    'being removed from the lottery returns to the join screen',
    activeScreen(doc) === 'idle',
    `showing "${activeScreen(doc)}" — a waiting screen here would be a lie`,
  );
  check('and registration is no longer offered', doc.getElementById('joinBtn').disabled === true);

  // --- 4. winning ----------------------------------------------------------
  section('4 · winning and playing');
  socket.deliver({ t: 'entry', entered: true });
  socket.deliver({ t: 'state', state: publicState({ entrants: 1 }) });
  await tick();
  socket.deliver({
    t: 'won',
    grantToken: 'token-abc',
    grantId: 'g1',
    activationDeadline: Date.now() + 10_000,
    durationMs: 30_000,
    pad: { x: 0.5, y: 0.5 },
    macroNames: { x: 'Filter', y: 'Delay' },
  });
  await tick();
  check('the winner is offered the control', activeScreen(doc) === 'won', `showing "${activeScreen(doc)}"`);
  check('with a button to take it', doc.getElementById('startBtn').textContent.includes('contrôle'));

  doc.getElementById('startBtn').dispatchEvent(new window.Event('click'));
  await tick();
  const activate = socket.sentOf('activate')[0];
  check('taking it activates the grant', activate?.grantToken === 'token-abc');

  socket.deliver({ t: 'active', expiresAt: Date.now() + 30_000, durationMs: 30_000, rateHz: 15 });
  await tick();
  check('the pad appears', activeScreen(doc) === 'pad', `showing "${activeScreen(doc)}"`);
  check('the pad is not locked', doc.getElementById('pad').classList.contains('locked') === false);
  check(
    'the macro names are on the axes',
    text(doc, 'labelX') === 'Filter' && text(doc, 'labelY') === 'Delay',
    `${text(doc, 'labelX')} × ${text(doc, 'labelY')}`,
  );

  // --- 5. the end ----------------------------------------------------------
  section('5 · the end of the window');
  socket.deliver({ t: 'ended', reason: 'expired' });
  await tick();
  check('the pad locks', doc.getElementById('pad').classList.contains('locked') === true);
  check('and the end screen is shown', activeScreen(doc) === 'ended', `showing "${activeScreen(doc)}"`);
  check('offering the next draw', doc.getElementById('againBtn').textContent.includes('prochain'));
  check('exactly one screen visible throughout', activeCount(doc) === 1);
  check('no script errors during the whole flow', errors.length === 0, errors[0] ?? '');

  window.close();
}

main()
  .then(() => {
    console.log(`\n\x1b[1m${passed} checks passed, ${failures.length} failed\x1b[0m`);
    if (failures.length) {
      for (const f of failures) console.log(`  \x1b[31m·\x1b[0m ${f}`);
      process.exit(1);
    }
    console.log('\x1b[32mThe participant page renders and behaves.\x1b[0m\n');
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n\x1b[31mAborted:\x1b[0m ${err.stack ?? err.message}`);
    process.exit(1);
  });
