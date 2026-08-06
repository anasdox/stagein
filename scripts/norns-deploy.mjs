#!/usr/bin/env node
/**
 * Deploy the StageIn script to a Norns.
 *
 *   mise run norns:deploy                      # we@norns.local
 *   NORNS=we@10.0.0.7 mise run norns:deploy
 *
 * Preflights the device before copying anything: the assumptions in PRD §18
 * ("the Norns can run a Lua client or a small companion service") are checked
 * against the actual machine rather than trusted. A failure here is cheap; the
 * same failure during a soundcheck is not.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from './norns-package.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = process.env.NORNS || process.argv[2] || 'we@norns.local';
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new'];

let failed = false;

function step(label) {
  process.stdout.write(`  ${label.padEnd(46)}`);
}

function ok(detail = '') {
  console.log(`\x1b[32mok\x1b[0m${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`);
}

function bad(detail = '') {
  failed = true;
  console.log(`\x1b[31mFAIL\x1b[0m${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`);
}

/** Run a command on the device. Returns trimmed stdout, or null on failure. */
function remote(command) {
  const result = spawnSync('ssh', [...SSH_OPTS, TARGET, command], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

function main() {
  console.log(`StageIn — deploy to ${TARGET}`);

  if (!existsSync('/usr/bin/ssh') && spawnSync('ssh', ['-V'], { encoding: 'utf8' }).error) {
    console.error('\n\x1b[31mssh is not available on this machine.\x1b[0m');
    process.exit(1);
  }

  console.log('\n\x1b[1mPreflight\x1b[0m');

  step('device reachable over ssh');
  const uname = remote('uname -sm');
  if (uname) ok(uname);
  else {
    bad('cannot connect');
    console.error(`
The device did not answer. Check that:
  · the Norns is powered on and on the same network
  · ${TARGET} is correct (try the IP shown in the Norns' SYSTEM > WIFI menu)
  · your ssh key is authorised, or run once interactively:  ssh ${TARGET}
    (the stock password on a Norns is "sleep")
`);
    process.exit(1);
  }

  step('python3 present (the bridge needs it)');
  const python = remote('python3 -V 2>&1');
  if (python && /Python 3/.test(python)) ok(python);
  else bad(python ?? 'not found');

  step('setsid present (detaches the bridge)');
  const setsid = remote('command -v setsid');
  if (setsid) ok(setsid);
  else bad('not found — the bridge would die with matron');

  step('dust directories present');
  const dust = remote('test -d ~/dust/code && echo yes');
  if (dust === 'yes') ok('~/dust/code');
  else bad('~/dust/code missing — is this a Norns?');

  step('tar present (used for the copy)');
  const tar = remote('command -v tar');
  if (tar) ok(tar);
  else bad('not found');

  if (failed) {
    console.error('\n\x1b[31mPreflight failed — nothing was copied.\x1b[0m\n');
    process.exit(1);
  }

  console.log('\n\x1b[1mPackage\x1b[0m');
  const { bundle, version } = build({ quiet: true });
  console.log(`  bundle ${version} ready`);

  console.log('\n\x1b[1mCopy\x1b[0m');
  step('stopping any running bridge');
  remote('pkill -f stagein_bridge.py 2>/dev/null; true');
  ok();

  step('extracting into ~/dust/code');
  // Stream the tree straight in: no scp recursion quirks, no temp files left on
  // a device with limited space.
  try {
    const tarball = execFileSync('tar', ['-C', join(bundle, '..'), '-czf', '-', 'stagein'], {
      maxBuffer: 32 * 1024 * 1024,
    });
    const result = spawnSync(
      'ssh',
      [...SSH_OPTS, TARGET, 'mkdir -p ~/dust/code && tar -C ~/dust/code -xzf -'],
      { input: tarball, encoding: 'buffer' },
    );
    if (result.status !== 0) throw new Error(result.stderr?.toString() ?? 'tar over ssh failed');
    ok();
  } catch (err) {
    bad(err.message);
    process.exit(1);
  }

  step('verifying the installed files');
  const installed = remote(
    'cd ~/dust/code/stagein && for f in stagein.lua lib/engine.lua lib/json.lua lib/relay_osc.lua bridge/stagein_bridge.py; do test -s "$f" || echo "MISSING $f"; done; echo done',
  );
  if (installed === 'done') ok('all five files present');
  else bad(installed ?? 'verification failed');

  step('bridge compiles on the device');
  const compiles = remote('python3 -m py_compile ~/dust/code/stagein/bridge/stagein_bridge.py 2>&1 && echo ok');
  if (compiles && compiles.endsWith('ok')) ok();
  else bad(compiles ?? 'py_compile failed');

  const config = remote('test -f ~/dust/data/stagein/config.json && echo yes');

  console.log(`\n\x1b[1m${failed ? 'Deployed with problems' : 'Deployed'}\x1b[0m`);
  if (config === 'yes') {
    console.log(`
  The device already has ~/dust/data/stagein/config.json — check that its
  relay_ws_url and norns_token still match this relay, then on the Norns:

    SELECT > stagein   (reload if it is already loaded)
`);
  } else {
    console.log(`
  Next, on the Norns: SELECT > stagein. The first load writes a config template
  and tells you so on screen. Then fill it in:

    ssh ${TARGET} 'nano ~/dust/data/stagein/config.json'

      relay_ws_url  wss://your-relay/ws/norns   (ws:// on a LAN)
      session       the session code
      norns_token   from the host console

  Reload the script, then hold K3 to arm. Watch the bridge with:

    mise run norns:logs
`);
  }
  process.exit(failed ? 1 : 0);
}

main();
