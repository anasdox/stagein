#!/usr/bin/env node
/**
 * Deploy the relay to a public VPS.
 *
 *   mise run vps:check     is the machine ready? (read-only)
 *   mise run vps:setup     install docker and the firewall (once)
 *   mise run vps:deploy    ship, build, start, verify over HTTPS
 *   mise run vps:status    what is running, and is the Norns connected
 *   mise run vps:logs      tail the relay
 *   mise run vps:stop      take it down
 *
 * Only the relay goes on the VPS. The Norns — real or simulated — stays where
 * the music is and dials out to it (PRD §11: no inbound access to the venue).
 * The simulator's front panel is unauthenticated and can arm and kill the rig,
 * so it must never be published.
 *
 * Secrets live on the server, in ~/stagein/deploy/.env, generated there on first
 * deploy. They are never written into this repository.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.VPS_HOST || 'ubuntu@92.222.171.209';
const DOMAIN = process.env.STAGEIN_DOMAIN || 'stagein.betafactory.co';
const REMOTE_DIR = process.env.VPS_DIR || 'stagein';
const SESSION = (process.env.BOOTSTRAP_SESSION_ID || 'LIVE01').toUpperCase();

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];

const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const D = '\x1b[90m';
const B = '\x1b[1m';
const O = '\x1b[0m';

const ok = (l, d = '') => console.log(`  ${G}ok  ${O} ${l}${d ? ` ${D}${d}${O}` : ''}`);
const warn = (l, d = '') => console.log(`  ${Y}warn${O} ${l}${d ? ` ${D}${d}${O}` : ''}`);
const bad = (l, d = '') => console.log(`  ${R}FAIL${O} ${l}${d ? ` ${D}${d}${O}` : ''}`);
const step = (t) => console.log(`\n${B}${t}${O}`);

/** Run on the VPS. Returns trimmed stdout, or null when the command failed. */
function remote(command, { input } = {}) {
  const result = spawnSync('ssh', [...SSH_OPTS, HOST, command], {
    encoding: input ? 'buffer' : 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return (result.stdout?.toString() ?? '').trim();
}

function requireAccess() {
  const who = remote('id -un');
  if (who) return who;
  console.error(`
${R}Cannot reach ${HOST} with a key.${O}

Authorise your key once — it will ask for the password:

    ssh-copy-id -i ~/.ssh/id_ed25519.pub ${HOST}

After that no password is needed again, and it never has to pass through here.
`);
  process.exit(1);
}


/**
 * Everything a fresh clone would hold, as a tarball.
 *
 * `git ls-files` reports files that are still tracked but already deleted from
 * the working tree, and tar aborts the entire transfer on the first missing
 * one — so the list is filtered against the disk before it is used.
 */
function packWorkingTree() {
  const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((relative) => existsSync(join(ROOT, relative)));

  try {
    return execFileSync('tar', ['--null', '-T', '-', '-czf', '-'], {
      cwd: ROOT,
      input: `${listed.join('\0')}\0`,
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`could not pack the working tree: ${err.stderr?.toString().trim() || err.message}`);
  }
}

// ---------------------------------------------------------------------------

async function check() {
  console.log(`${B}StageIn — VPS check${O}`);
  console.log(`${D}${HOST} · ${DOMAIN}${O}`);

  step('access');
  const who = requireAccess();
  ok('ssh with a key', `as ${who}`);
  ok('host', remote('hostname') ?? '?');
  ok('os', remote('lsb_release -ds 2>/dev/null || cat /etc/os-release | head -1') ?? '?');
  ok('resources', `${remote('nproc')} cpu · ${remote("free -m | awk '/Mem:/{print $2}'")} MB RAM · ${remote("df -h / | awk 'NR==2{print $4}'")} free`);

  step('runtime');
  const docker = remote('docker --version 2>/dev/null');
  if (docker) ok('docker', docker);
  else bad('docker is not installed', 'run: mise run vps:setup');

  const compose = remote('docker compose version --short 2>/dev/null');
  if (compose) ok('docker compose', `v${compose}`);
  else if (docker) bad('docker compose plugin missing', 'run: mise run vps:setup');

  const inGroup = remote('id -nG | tr " " "\\n" | grep -qx docker && echo yes');
  if (inGroup === 'yes') ok('user can run docker without sudo');
  else if (docker) warn('user is not in the docker group', 'run: mise run vps:setup');

  step('network');
  // Certificate issuance needs 80 reachable from the internet, and the name has
  // to point here — both are Let's Encrypt preconditions, not nice-to-haves.
  //
  // Resolved from here, not on the VPS: Ubuntu maps its own hostname to
  // 127.0.1.1 in /etc/hosts, so asking the machine what its name resolves to
  // answers with the loopback and looks like a misconfigured zone.
  const publicIp = remote('curl -s --max-time 8 https://api.ipify.org || true');
  let addresses = null;
  try {
    addresses = await dns.resolve4(DOMAIN);
  } catch {
    /* reported below */
  }
  if (addresses?.length && publicIp && addresses.includes(publicIp)) {
    ok('public DNS points at this machine', `${DOMAIN} → ${addresses.join(', ')}`);
  } else if (addresses?.length) {
    warn('public DNS does not match the machine public IP', `${DOMAIN} → ${addresses.join(', ')}, machine → ${publicIp}`);
  } else {
    bad('the domain does not resolve publicly', DOMAIN);
  }

  const listening = remote("ss -tlnp 2>/dev/null | awk 'NR>1{print $4}' | grep -E ':(80|443)$' || true");
  if (listening) warn('something already listens on 80/443', listening.replace(/\n/g, ' '));
  else ok('ports 80 and 443 are free');

  const ufw = remote('sudo -n ufw status 2>/dev/null | head -1 || echo unknown');
  ok('firewall', ufw || 'unknown');

  step('deployment');
  const present = remote(`test -d ~/${REMOTE_DIR} && echo yes`);
  if (present === 'yes') {
    ok('already deployed', `~/${REMOTE_DIR}`);
    const running = remote(`cd ~/${REMOTE_DIR} && docker compose -f deploy/docker-compose.prod.yml ps --format '{{.Service}} {{.State}}' 2>/dev/null || true`);
    console.log(running ? running.split('\n').map((l) => `         ${l}`).join('\n') : '         (nothing running)');
  } else ok('not deployed yet', 'run: mise run vps:deploy');
  console.log('');
}

// ---------------------------------------------------------------------------

function setup() {
  console.log(`${B}StageIn — VPS setup${O}  ${D}${HOST}${O}`);
  requireAccess();

  step('docker');
  if (remote('docker --version 2>/dev/null')) ok('already installed');
  else {
    console.log(`  ${D}installing from get.docker.com…${O}`);
    const out = remote('curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sudo sh /tmp/get-docker.sh 2>&1 | tail -3');
    if (out === null) return bad('docker installation failed', 'run it by hand and re-check');
    ok('installed', remote('docker --version') ?? '');
  }

  if (remote('id -nG | tr " " "\\n" | grep -qx docker && echo yes') !== 'yes') {
    remote('sudo usermod -aG docker $(id -un)');
    ok('user added to the docker group', 'takes effect on the next connection');
  } else ok('user already in the docker group');

  step('firewall');
  if (remote('command -v ufw')) {
    // Order matters: allow ssh *before* enabling, or this locks you out of your
    // own machine with no console.
    remote('sudo ufw allow OpenSSH');
    remote('sudo ufw allow 80/tcp');
    remote('sudo ufw allow 443/tcp');
    const status = remote('sudo ufw --force enable && sudo ufw status | head -8');
    ok('ufw: 22, 80, 443 only');
    if (status) console.log(status.split('\n').map((l) => `         ${D}${l}${O}`).join('\n'));
  } else warn('ufw not present', 'skipping firewall configuration');

  step('unattended upgrades');
  if (remote('dpkg -s unattended-upgrades 2>/dev/null | grep -q "Status: install ok" && echo yes') === 'yes') {
    ok('already enabled');
  } else {
    remote('sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades');
    ok('installed');
  }

  console.log(`\n${G}Ready.${O} Next: ${B}mise run vps:deploy${O}\n`);
}

// ---------------------------------------------------------------------------

function deploy() {
  console.log(`${B}StageIn — deploy to ${DOMAIN}${O}`);
  requireAccess();

  if (!remote('docker compose version --short 2>/dev/null')) {
    bad('docker compose is not available on the VPS', 'run: mise run vps:setup');
    process.exit(1);
  }

  step('ship');
  // Exactly what a fresh clone holds — no node_modules, no dist, no .env.
  const tarball = packWorkingTree();
  const shipped = spawnSync(
    'ssh',
    [...SSH_OPTS, HOST, `mkdir -p ~/${REMOTE_DIR} && tar -C ~/${REMOTE_DIR} -xzf -`],
    { input: tarball, encoding: 'buffer' },
  );
  if (shipped.status !== 0) {
    bad('copy failed', shipped.stderr?.toString().trim());
    process.exit(1);
  }
  ok('sources copied', `${(tarball.length / 1024).toFixed(0)} KB → ~/${REMOTE_DIR}`);

  step('secrets');
  const envPath = `~/${REMOTE_DIR}/deploy/.env`;
  const exists = remote(`test -f ${envPath} && echo yes`);
  if (exists === 'yes') {
    ok('server-side .env already present', 'left untouched');
  } else {
    // Generated on the server: the tokens never touch this laptop or the repo.
    const created = remote(
      `umask 077 && cat > ${envPath} <<EOF
STAGEIN_DOMAIN=${DOMAIN}
BOOTSTRAP_SESSION_ID=${SESSION}
BOOTSTRAP_HOST_TOKEN=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')
BOOTSTRAP_NORNS_TOKEN=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')
ALLOW_PUBLIC_SESSION_CREATE=false
EOF
echo created`,
    );
    if (created !== 'created') {
      bad('could not write the server .env');
      process.exit(1);
    }
    ok('tokens generated on the server', envPath);
  }

  step('build and start');
  const up = remote(
    `cd ~/${REMOTE_DIR} && docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build 2>&1 | tail -6`,
  );
  if (up === null) {
    bad('compose failed', 'see: mise run vps:logs');
    process.exit(1);
  }
  console.log(up.split('\n').map((l) => `         ${D}${l}${O}`).join('\n'));

  step('verify');
  // Caddy has to fetch a certificate on first boot; give it room.
  let health = null;
  for (let i = 0; i < 20; i++) {
    health = remote(`curl -fsS --max-time 6 https://${DOMAIN}/healthz 2>/dev/null || true`);
    if (health) break;
    execFileSync('sleep', ['3']);
  }
  if (health) ok('reachable over HTTPS', health);
  else {
    bad('not answering over HTTPS yet', `check certificate issuance: mise run vps:logs`);
    process.exitCode = 1;
  }

  const env = remote(`cat ${envPath}`) ?? '';
  const value = (key) => env.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? '?';

  console.log(`\n${B}Live${O}`);
  console.log(`  host console   https://${DOMAIN}/host/${value('BOOTSTRAP_SESSION_ID')}#t=${value('BOOTSTRAP_HOST_TOKEN')}`);
  console.log(`  stage view     https://${DOMAIN}/stage/${value('BOOTSTRAP_SESSION_ID')}`);
  console.log(`  join link      ${D}open the host console — it carries the rotating key${O}`);
  console.log(`\n${B}Point the Norns at it${O}`);
  console.log(`  relay_ws_url   wss://${DOMAIN}/ws/norns`);
  console.log(`  session        ${value('BOOTSTRAP_SESSION_ID')}`);
  console.log(`  norns_token    ${value('BOOTSTRAP_NORNS_TOKEN')}`);
  console.log(`\n  ${D}locally:  RELAY_WS_URL=wss://${DOMAIN}/ws/norns STAGEIN_SESSION=${value('BOOTSTRAP_SESSION_ID')} \\`);
  console.log(`            STAGEIN_NORNS_TOKEN=${value('BOOTSTRAP_NORNS_TOKEN')} mise run norns${O}`);
  console.log(`\n  ${D}on hardware:  mise run norns:config${O}\n`);
}

// ---------------------------------------------------------------------------

function status() {
  requireAccess();
  const ps = remote(`cd ~/${REMOTE_DIR} && docker compose -f deploy/docker-compose.prod.yml ps --format '{{.Service}}\t{{.State}}\t{{.Status}}' 2>/dev/null`);
  console.log(ps || '(nothing deployed)');
  const health = remote(`curl -fsS --max-time 6 https://${DOMAIN}/healthz 2>/dev/null || echo unreachable`);
  console.log(`\nhttps://${DOMAIN}/healthz → ${health}`);
}

function logs() {
  requireAccess();
  const service = process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : '';
  spawnSync(
    'ssh',
    [...SSH_OPTS, '-t', HOST, `cd ~/${REMOTE_DIR} && docker compose -f deploy/docker-compose.prod.yml logs -f --tail 80 ${service}`],
    { stdio: 'inherit' },
  );
}

function stop() {
  requireAccess();
  console.log(remote(`cd ~/${REMOTE_DIR} && docker compose -f deploy/docker-compose.prod.yml down 2>&1 | tail -4`) ?? 'failed');
}

// ---------------------------------------------------------------------------

const COMMANDS = { check, setup, deploy, status, logs, stop };
const command = process.argv[2];
if (!command || !COMMANDS[command]) {
  console.error(`usage: vps.mjs <${Object.keys(COMMANDS).join('|')}>`);
  process.exit(2);
}
await COMMANDS[command]();
