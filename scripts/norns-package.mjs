#!/usr/bin/env node
/**
 * Assemble the Norns deployable.
 *
 * Output tree is exactly what lands in ~/dust/code, so the tarball can be
 * extracted there directly:
 *
 *   dist/norns/stagein/stagein.lua              entry point matron loads
 *   dist/norns/stagein/lib/engine.lua           the musical logic
 *   dist/norns/stagein/lib/json.lua
 *   dist/norns/stagein/lib/relay_osc.lua        device transport
 *   dist/norns/stagein/bridge/stagein_bridge.py companion holding the link
 *   dist/norns/stagein/MANIFEST.txt             sha256 of every file above
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'packages', 'norns-script');
const OUT_DIR = join(ROOT, 'dist', 'norns');
const BUNDLE = join(OUT_DIR, 'stagein');

/** Every file the device needs. Kept explicit so a new file cannot be forgotten. */
export const REQUIRED_FILES = [
  'stagein.lua',
  'lib/engine.lua',
  'lib/json.lua',
  'lib/relay_osc.lua',
  'bridge/stagein_bridge.py',
];

export function bundlePath() {
  return BUNDLE;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function build({ quiet = false } = {}) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(BUNDLE, { recursive: true });

  for (const relative of REQUIRED_FILES) {
    const from = join(SOURCE, relative);
    const to = join(BUNDLE, relative);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }

  const lines = [
    `StageIn norns bundle ${version}`,
    '',
    ...REQUIRED_FILES.map((relative) => `${sha256(join(BUNDLE, relative))}  ${relative}`),
    '',
    'Install:  extract into ~/dust/code/ so the tree becomes ~/dust/code/stagein/',
    'Configure: ~/dust/data/stagein/config.json (written on first run)',
  ];
  writeFileSync(join(BUNDLE, 'MANIFEST.txt'), `${lines.join('\n')}\n`);

  const tarball = join(OUT_DIR, `stagein-norns-${version}.tgz`);
  execFileSync('tar', ['-C', OUT_DIR, '-czf', tarball, 'stagein']);

  if (!quiet) {
    console.log(`bundle   ${BUNDLE}`);
    console.log(`tarball  ${tarball}`);
    for (const relative of REQUIRED_FILES) {
      console.log(`  ${sha256(join(BUNDLE, relative)).slice(0, 12)}  ${relative}`);
    }
  }
  return { bundle: BUNDLE, tarball, version };
}

if (import.meta.url === `file://${process.argv[1]}`) build();
