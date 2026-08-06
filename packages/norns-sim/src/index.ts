import { loadConfig } from './config';
import { LuaNorns, type ScreenFrame } from './lua-host';
import { MidiOut } from './midi';
import { RelayClient } from './relay-client';
import { PanelServer } from './web';

async function main(): Promise<void> {
  const config = loadConfig();

  console.log('--- StageIn Norns simulator -------------------------------');
  console.log(`  script    lua/stagein.lua  (Lua 5.4 interpreter)`);
  console.log(`  relay     ${config.relayWsUrl}`);
  console.log(`  session   ${config.sessionId}`);
  console.log(`  arm mode  ${config.armMode}`);
  console.log(`  output    ${config.midiBackend}`);
  console.log(`  panel     http://localhost:${config.port}`);
  console.log('-----------------------------------------------------------');

  const midi = new MidiOut(config);

  // Declared up front because the pieces reference each other: Lua sends to the
  // relay, the relay feeds Lua, and the panel drives both.
  let lua: LuaNorns | null = null;
  let panel: PanelServer | null = null;

  const relay = new RelayClient(config, {
    onOpen: () => lua?.relayOpen(),
    onClose: () => lua?.relayClose(),
    onMessage: (payload) => lua?.relayMessage(payload),
    onLog: (level, message) => log(level, message),
  });

  function log(level: string, message: string): void {
    const line = `[norns] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    panel?.pushLog(level, message);
  }

  lua = new LuaNorns(
    {
      log,
      screen: (frame: ScreenFrame) => panel?.pushScreen(frame),
      midiCc: (channel, cc, value) => midi.cc(channel, cc, value),
      osc: (address, value) => midi.osc(address, value),
      wsSend: (payload) => relay.send(payload),
    },
    { armMode: config.armMode, midiBackend: config.midiBackend, tickMs: config.tickMs },
  );

  panel = new PanelServer(config.port, {
    enc: (n, d) => lua?.enc(n, d),
    key: (n, z) => lua?.key(n, z),
    pair: (session, token) => relay.pair(session, token),
    snapshot: () => ({
      device: lua?.deviceState() ?? {},
      relay: {
        connected: relay.connected,
        url: relay.url,
        session: relay.sessionId,
        error: relay.lastError,
      },
      midi: { count: midi.count, recent: midi.monitor.slice(-40) },
    }),
  });

  midi.onEvent((event) => panel?.pushCc(event));

  await lua.boot();
  panel.start();
  relay.start();

  // Compact stage-side status line, so `docker compose logs` stays readable.
  const heartbeat = setInterval(() => {
    const d = lua?.deviceState() ?? {};
    const mode = d.killed ? 'KILLED' : d.armed ? (d.authorised ? 'ARMED>>' : 'ARMED') : 'IDLE';
    console.log(
      `[norns] ${mode} ${relay.connected ? d.session ?? '?' : 'OFFLINE'} ${String(d.sessionState ?? '-')} ` +
        `${String(d.entrants ?? 0)}/${String(d.connected ?? 0)} ` +
        `CC${String(d.x && (d.x as { cc: number }).cc)}=${String(d.ccX ?? 0)} ` +
        `CC${String(d.y && (d.y as { cc: number }).cc)}=${String(d.ccY ?? 0)} ` +
        `acc=${String(d.accepted ?? 0)} rej=${String(d.rejected ?? 0)}`,
    );
  }, 5_000);

  const shutdown = (signal: string): void => {
    console.log(`[norns] ${signal} — returning to safe values and exiting`);
    // Silence everything that calls into Lua before the interpreter goes away;
    // `lua.shutdown()` still guards itself, but this keeps the order honest.
    clearInterval(heartbeat);
    panel?.stop();
    relay.stop();
    // Emits the safe CC values on its way out, so the rig is never left on a
    // participant's last gesture.
    lua?.shutdown();
    midi.close();
    setTimeout(() => process.exit(0), 150);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[norns] fatal', err);
  process.exit(1);
});
