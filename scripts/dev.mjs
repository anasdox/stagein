#!/usr/bin/env node
// Runs the relay and the Norns simulator side by side with prefixed output.
// `mise run dev` builds first, so both start from fresh dist/ output.

import { spawn } from 'node:child_process';

const SERVICES = [
  { name: 'relay', color: '\x1b[36m', args: ['--watch', 'packages/relay/dist/index.js'] },
  { name: 'norns', color: '\x1b[33m', args: ['--watch', 'packages/norns-sim/dist/index.js'] },
];

const RESET = '\x1b[0m';
const children = [];
let shuttingDown = false;

for (const service of SERVICES) {
  const child = spawn(process.execPath, service.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  children.push(child);

  const prefix = `${service.color}${service.name.padEnd(5)}${RESET} │ `;
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
  }

  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    shutdown(code ?? 1);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
