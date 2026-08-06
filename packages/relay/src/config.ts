import { randomToken } from './ids';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export interface RelayConfig {
  port: number;
  host: string;
  /** Base URL burned into join links and QR codes. */
  publicBaseUrl: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** A session created at boot so the stack is immediately usable. */
  bootstrap: {
    sessionId: string;
    hostToken: string;
    nornsToken: string;
  } | null;
  /** Presence: how long without a frame before a socket is considered gone (FR-04). */
  heartbeatMs: number;
  idleTimeoutMs: number;
  /** How long a disconnected participant record survives, for reconnection (NFR-05). */
  reconnectWindowMs: number;
  /** Hard ceiling on participants per session (NFR-03). */
  maxParticipants: number;
  maxFrameBytes: number;
}

export function loadConfig(): RelayConfig {
  const port = intEnv('PORT', 8080);
  const bootstrapId = env('BOOTSTRAP_SESSION_ID', '').toUpperCase().trim();

  return {
    port,
    host: env('HOST', '0.0.0.0'),
    publicBaseUrl: env('PUBLIC_BASE_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
    logLevel: env('LOG_LEVEL', 'info') as RelayConfig['logLevel'],
    bootstrap: bootstrapId
      ? {
          sessionId: bootstrapId,
          hostToken: env('BOOTSTRAP_HOST_TOKEN', randomToken(16)),
          nornsToken: env('BOOTSTRAP_NORNS_TOKEN', randomToken(16)),
        }
      : null,
    heartbeatMs: intEnv('HEARTBEAT_MS', 2_000),
    idleTimeoutMs: intEnv('IDLE_TIMEOUT_MS', 8_000),
    reconnectWindowMs: intEnv('RECONNECT_WINDOW_MS', 20_000),
    maxParticipants: intEnv('MAX_PARTICIPANTS', 200),
    maxFrameBytes: intEnv('MAX_FRAME_BYTES', 4_096),
  };
}
