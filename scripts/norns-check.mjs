#!/usr/bin/env node
/**
 * Is the Norns bundle actually deployable?
 *
 * Runs without hardware and without a relay. Checks, in order:
 *
 *  1. every required file is present and non-empty;
 *  2. every Lua file parses — in a real Lua 5.4 interpreter, not a regex;
 *  3. the bridge compiles under python3, the only runtime the device needs;
 *  4. the entry point's include() paths match the deployed layout;
 *  5. engine.lua does not depend on the emulator outside its declared seam —
 *     the failure mode that would make a rehearsal prove nothing;
 *  6. the packaged engine is byte-identical to the one the simulator runs;
 *  7. the packaged engine boots and produces MIDI in the interpreter.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_FILES, build } from './norns-package.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Resolve from inside the simulator package: that is where wasmoon and the
// compiled host live, and it keeps the repo root dependency-free.
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

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function main() {
  console.log('StageIn — Norns bundle readiness');
  const { bundle, tarball, version } = build({ quiet: true });
  console.log(`version ${version} · ${bundle}`);

  // --- 1. completeness -----------------------------------------------------
  section('1 · bundle completeness');
  for (const relative of [...REQUIRED_FILES, 'MANIFEST.txt']) {
    let size = -1;
    try {
      size = statSync(join(bundle, relative)).size;
    } catch {
      /* reported below */
    }
    check(relative, size > 0, size >= 0 ? `${size} bytes` : 'missing');
  }
  check('tarball produced', statSync(tarball).size > 0, tarball.replace(`${ROOT}/`, ''));

  // --- 2. Lua parses in a real interpreter ---------------------------------
  section('2 · Lua syntax (Lua 5.4)');
  const { LuaFactory } = require('wasmoon');
  const luaFiles = REQUIRED_FILES.filter((f) => f.endsWith('.lua'));
  for (const relative of luaFiles) {
    const source = readFileSync(join(bundle, relative), 'utf8');
    const lua = await new LuaFactory().createEngine();
    let error = null;
    try {
      lua.global.set('SRC', source);
      lua.global.set('NAME', relative);
      // load() compiles without running, so device-only globals stay unresolved.
      await lua.doString('local f, e = load(SRC, NAME); if not f then error(e, 0) end');
    } catch (err) {
      error = err.message ?? String(err);
    } finally {
      lua.global.close();
    }
    check(`${relative} compiles`, error === null, error ?? '');
  }

  // --- 3. the bridge's only runtime dependency -----------------------------
  section('3 · bridge runtime (python3 stdlib only)');
  const bridge = join(bundle, 'bridge', 'stagein_bridge.py');
  let pyVersion = null;
  try {
    pyVersion = execFileSync('python3', ['-V'], { encoding: 'utf8' }).trim();
  } catch {
    /* absent locally */
  }
  if (pyVersion) {
    let compileError = null;
    try {
      execFileSync('python3', ['-m', 'py_compile', bridge], { stdio: 'pipe' });
    } catch (err) {
      compileError = err.stderr?.toString() ?? String(err);
    }
    check('bridge compiles', compileError === null, `${pyVersion}${compileError ? ` — ${compileError}` : ''}`);
  } else {
    check('bridge compiles', false, 'python3 not available locally — cannot verify');
  }

  const bridgeSource = readFileSync(bridge, 'utf8');
  const thirdParty = [...bridgeSource.matchAll(/^\s*(?:import|from)\s+([a-zA-Z0-9_.]+)/gm)]
    .map((m) => m[1].split('.')[0])
    .filter((name) => !STDLIB.has(name));
  check(
    'bridge imports nothing outside the standard library',
    thirdParty.length === 0,
    thirdParty.length ? `found ${[...new Set(thirdParty)].join(', ')}` : 'stdlib only',
  );

  // --- 4. entry point wiring ----------------------------------------------
  section('4 · entry point wiring');
  const entry = readFileSync(join(bundle, 'stagein.lua'), 'utf8');
  const includes = [...entry.matchAll(/include\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  for (const expected of ['stagein/lib/json', 'stagein/lib/relay_osc', 'stagein/lib/engine']) {
    check(`includes ${expected}`, includes.includes(expected));
  }
  check(
    'the transport is loaded before the engine',
    includes.indexOf('stagein/lib/relay_osc') < includes.indexOf('stagein/lib/engine'),
    'engine calls relay.send() as soon as it is armed',
  );
  check(
    'every include resolves inside the bundle',
    includes.every((path) => {
      const relative = `${path.replace(/^stagein\//, '')}.lua`;
      try {
        return statSync(join(bundle, relative)).size > 0;
      } catch {
        return false;
      }
    }),
    includes.join(', '),
  );

  // --- 5. no hidden emulator dependency -----------------------------------
  section('5 · engine independence from the simulator');
  const engineSource = readFileSync(join(bundle, 'lib', 'engine.lua'), 'utf8');
  // Only these forms are allowed: each one falls back to a matron facility.
  const ALLOWED_SEAM = [
    /^local now_ms = _host_now or /,
    /^  if _host_log then$/,
    /^    _host_log\(level, message\)$/,
    /^local ARM_MODE = _host_arm_mode or /,
    /^local MIDI_BACKEND = _host_midi_backend or /,
  ];
  const offending = engineSource
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes('_host_') && !line.trimStart().startsWith('--'))
    .filter(({ line }) => !ALLOWED_SEAM.some((pattern) => pattern.test(line)));
  check(
    'engine touches the emulator only through its declared seam',
    offending.length === 0,
    offending.length ? offending.map((o) => `line ${o.n}: ${o.line.trim()}`).join(' | ') : '5 guarded references',
  );
  check(
    'engine gets json from the loader, not a hardcoded path',
    /_stagein_json or require\('json'\)/.test(engineSource),
  );
  check(
    'engine defines the lifecycle matron calls',
    ['function init(', 'function redraw(', 'function enc(', 'function key(', 'function cleanup('].every((fn) =>
      engineSource.includes(fn),
    ),
  );

  // --- 6. the simulator runs the shipped bytes ----------------------------
  section('6 · simulator and device run the same engine');
  const shipped = join(bundle, 'lib', 'engine.lua');
  const simulated = join(ROOT, 'packages', 'norns-script', 'lib', 'engine.lua');
  check('engine.lua is byte-identical', sha256(shipped) === sha256(simulated), sha256(shipped).slice(0, 16));
  const simHost = readFileSync(join(ROOT, 'packages', 'norns-sim', 'src', 'lua-host.ts'), 'utf8');
  check(
    'the simulator mounts it from the deployable package',
    /norns-script', 'lib'/.test(simHost),
    'no second copy to drift',
  );

  // --- 7. the packaged engine actually boots ------------------------------
  section('7 · the packaged engine boots and emits');
  const { LuaNorns } = require(join(ROOT, 'packages', 'norns-sim', 'dist', 'lua-host.js'));
  const cc = [];
  const logs = [];
  const norns = new LuaNorns(
    {
      log: (level, message) => logs.push(`${level}: ${message}`),
      screen: () => {},
      midiCc: (channel, controller, value) => cc.push({ channel, controller, value }),
      osc: () => {},
      wsSend: () => {},
    },
    {
      armMode: 'latch',
      midiBackend: 'log',
      tickMs: 5,
      // Point the interpreter at the *bundle*, not the source tree.
      scriptDir: join(bundle, 'lib'),
      harnessDir: join(ROOT, 'packages', 'norns-sim', 'lua'),
    },
  );
  let bootError = null;
  try {
    await norns.boot();
    await new Promise((r) => setTimeout(r, 300));
  } catch (err) {
    bootError = err.message ?? String(err);
  }
  check('boots in the interpreter', bootError === null, bootError ?? logs[0] ?? '');
  check('emits the two safe CC values on load', cc.length >= 2, cc.map((e) => `CC${e.controller}=${e.value}`).join(' '));
  const state = norns.deviceState?.() ?? {};
  check('reports a coherent device state', typeof state.preset === 'string', `preset=${state.preset} armed=${state.armed}`);
  norns.shutdown?.();
}

/** Python 3.11 standard-library top-level modules this bridge could plausibly use. */
const STDLIB = new Set([
  '__future__', 'argparse', 'base64', 'binascii', 'collections', 'contextlib', 'dataclasses',
  'datetime', 'enum', 'errno', 'hashlib', 'io', 'json', 'logging', 'math', 'os', 'pathlib',
  'queue', 'random', 're', 'select', 'selectors', 'signal', 'socket', 'ssl', 'struct', 'subprocess',
  'sys', 'threading', 'time', 'traceback', 'typing', 'urllib', 'uuid',
]);

main()
  .then(() => {
    console.log(`\n\x1b[1m${passed} checks passed, ${failures.length} failed\x1b[0m`);
    if (failures.length) {
      for (const f of failures) console.log(`  \x1b[31m·\x1b[0m ${f}`);
      process.exit(1);
    }
    console.log('\x1b[32mBundle is deployable.\x1b[0m Next: mise run norns:bridge-test, then norns:deploy\n');
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n\x1b[31mAborted:\x1b[0m ${err.stack ?? err.message}`);
    process.exit(1);
  });
