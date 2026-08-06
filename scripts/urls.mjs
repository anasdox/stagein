#!/usr/bin/env node
// Prints the demo URLs for the bootstrap session, including the host token that
// only exists in configuration.

import { networkInterfaces } from 'node:os';

const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const id = (process.env.BOOTSTRAP_SESSION_ID || 'DEMO01').toUpperCase();
const hostToken = process.env.BOOTSTRAP_HOST_TOKEN || 'dev-host-token-change-me';
const nornsPort = process.env.NORNS_PORT || '8081';

async function joinUrl() {
  // The join link carries a rotating key, so ask the relay rather than guess.
  try {
    const res = await fetch(`${base}/api/sessions/${id}/public`);
    if (!res.ok) throw new Error(String(res.status));
    return `${base}/j/${id}  (exact link with its key: open the host console)`;
  } catch {
    return `${base}/j/${id}  (relay not reachable — start it first)`;
  }
}

function lanHints() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(`${name} → http://${addr.address}:8080`);
    }
  }
  return out;
}

console.log('StageIn — demo session');
console.log('─'.repeat(64));
console.log(`session      ${id}`);
console.log(`host console ${base}/host/${id}#t=${hostToken}`);
console.log(`participant  ${await joinUrl()}`);
console.log(`stage view   ${base}/stage/${id}`);
console.log(`  OBS source ${base}/stage/${id}?transparent=1`);
console.log(`norns panel  http://localhost:${nornsPort}`);
console.log('─'.repeat(64));

if (base.includes('localhost')) {
  const hints = lanHints();
  if (hints.length) {
    console.log('Phones cannot reach "localhost". For a real test set PUBLIC_BASE_URL to one of:');
    for (const hint of hints) console.log(`  ${hint}`);
  }
}
