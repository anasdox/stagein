function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export type MidiBackend = 'log' | 'osc' | 'midi';
export type ArmMode = 'latch' | 'deadman';

export interface NornsConfig {
  /** Emulator panel: the Norns screen, encoders, keys and MIDI monitor. */
  port: number;
  relayWsUrl: string;
  sessionId: string;
  nornsToken: string;
  armMode: ArmMode;
  midiBackend: MidiBackend;
  midiPortName: string;
  oscHost: string;
  oscPort: number;
  /** Append every emitted CC to this file, so output is auditable after a set. */
  midiLogFile: string | null;
  /** How often the host advances Lua metros and coroutines. */
  tickMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
}

export function loadConfig(): NornsConfig {
  const backend = env('MIDI_BACKEND', 'log');
  const armMode = env('ARM_MODE', 'latch');
  return {
    port: intEnv('NORNS_PORT', 8081),
    relayWsUrl: env('RELAY_WS_URL', 'ws://localhost:8080/ws/norns'),
    sessionId: env('STAGEIN_SESSION', 'DEMO01').toUpperCase(),
    nornsToken: env('STAGEIN_NORNS_TOKEN', 'dev-norns-token-change-me'),
    armMode: armMode === 'deadman' ? 'deadman' : 'latch',
    midiBackend: backend === 'osc' || backend === 'midi' ? backend : 'log',
    midiPortName: env('MIDI_PORT_NAME', 'StageIn'),
    oscHost: env('OSC_HOST', '127.0.0.1'),
    oscPort: intEnv('OSC_PORT', 57120),
    midiLogFile: process.env.MIDI_LOG_FILE || null,
    tickMs: intEnv('TICK_MS', 5),
    reconnectMinMs: intEnv('RECONNECT_MIN_MS', 500),
    reconnectMaxMs: intEnv('RECONNECT_MAX_MS', 5_000),
  };
}
