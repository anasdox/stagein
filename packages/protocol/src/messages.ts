/**
 * Wire protocol. Four WebSocket surfaces, all under /ws:
 *   /ws/participant  phone   — join, wait, play the pad
 *   /ws/host         artist  — configure, draw, supervise, kill
 *   /ws/norns        Norns   — outbound-only connection, receives x/y, reports state
 *   /ws/stage        public  — read-only view for OBS / projection
 */

import type { EndReason, SessionConfig, SessionState } from './session';

// ---------------------------------------------------------------------------
// Shared views
// ---------------------------------------------------------------------------

/** What everybody may know about a session. Contains no tokens. */
export interface PublicState {
  sessionId: string;
  state: SessionState;
  /** Connected participants currently in the lottery. */
  entrants: number;
  /** Connected participants, in the lottery or not. */
  connected: number;
  /** Set from DRAWING onwards. */
  winnerPseudo: string | null;
  /** ms until the draw fires, when state is DRAWING. */
  countdownMs: number | null;
  /** ms until the winner loses the pad, when state is AWARDED or ACTIVE. */
  remainingMs: number | null;
  nornsOnline: boolean;
  nornsArmed: boolean;
  killed: boolean;
  preset: string;
  macroNames: { x: string; y: string };
  endReason: EndReason | null;
}

/** Everything the host and the operator need (PRD §4, FR-14). */
export interface HostState extends PublicState {
  config: SessionConfig;
  joinUrl: string;
  stageUrl: string;
  participants: ParticipantView[];
  grant: GrantView | null;
  norns: NornsStatus | null;
  metrics: {
    /** Gesture → Norns reception, PRD NFR-01 target P95 < 250 ms. */
    latencyP50: number | null;
    latencyP95: number | null;
    latencySamples: number;
    /**
     * Where the figure comes from: `norns` is the full path measured by the
     * device, `relay` is the phone→relay leg only (used when no Norns is up).
     */
    latencySource: 'norns' | 'relay' | null;
    eventsIn: number;
    eventsDropped: number;
  };
}

export interface ParticipantView {
  clientId: string;
  pseudo: string;
  entered: boolean;
  connected: boolean;
  joinedAt: number;
  isWinner: boolean;
}

export interface GrantView {
  grantId: string;
  clientId: string;
  pseudo: string;
  awardedAt: number;
  /** Deadline for the winner to touch the pad. */
  activationDeadline: number;
  startedAt: number | null;
  expiresAt: number | null;
  revoked: boolean;
}

export interface NornsStatus {
  online: boolean;
  armed: boolean;
  killed: boolean;
  preset: string;
  /** Requested position, normalised. */
  targetX: number;
  targetY: number;
  /** Post-slew position, normalised. */
  outX: number;
  outY: number;
  /** Emitted MIDI CC values. */
  ccX: number;
  ccY: number;
  midiBackend: string;
  lastMessageAt: number | null;
  /** Messages the Norns itself rejected (stale, unauthorised, out of order). */
  rejected: number;
}

// ---------------------------------------------------------------------------
// Participant  ⇄  relay
// ---------------------------------------------------------------------------

export type ParticipantIn =
  /** First frame. `clientId` is the browser-local identity (one entry per device). */
  | { t: 'hello'; clientId: string; pseudo?: string }
  | { t: 'enter' }
  | { t: 'leave' }
  | { t: 'pseudo'; pseudo: string }
  /** Winner touched the pad: AWARDED → ACTIVE. */
  | { t: 'activate'; grantToken: string }
  /** A pad sample. `ts` is the phone's own clock; the relay corrects for skew. */
  | { t: 'xy'; grantToken: string; x: number; y: number; seq: number; ts: number }
  /** Clock-offset probe reply, used to make `ts` comparable to server time. */
  | { t: 'pong'; id: number; ts: number };

export type ParticipantOut =
  | { t: 'welcome'; clientId: string; pseudo: string; entered: boolean; state: PublicState }
  | { t: 'state'; state: PublicState }
  /** You won. Vibrate, show the pad, wait for `activate`. */
  | {
      t: 'won';
      grantToken: string;
      grantId: string;
      activationDeadline: number;
      durationMs: number;
      pad: { x: number; y: number };
      macroNames: { x: string; y: string };
    }
  /** Your pad is live until `expiresAt`. */
  | { t: 'active'; expiresAt: number; durationMs: number; rateHz: number }
  | { t: 'ended'; reason: EndReason }
  | { t: 'ping'; id: number; ts: number }
  | { t: 'error'; code: ErrorCode; message: string };

// ---------------------------------------------------------------------------
// Host  ⇄  relay
// ---------------------------------------------------------------------------

export type HostIn =
  | { t: 'hello'; hostToken: string }
  | { t: 'open' }
  | { t: 'close' }
  | { t: 'reset' }
  | { t: 'draw'; countdownMs?: number }
  | { t: 'revoke' }
  /** Software emergency stop (FR-12). */
  | { t: 'kill' }
  | { t: 'unkill' }
  | { t: 'config'; patch: Record<string, unknown> }
  | { t: 'block'; clientId: string }
  /** Invalidate the join URL and regenerate the QR (PRD §11). */
  | { t: 'rotate' }
  | { t: 'pong'; id: number; ts: number };

export type HostOut =
  | { t: 'welcome'; state: HostState }
  | { t: 'state'; state: HostState }
  | { t: 'log'; at: number; level: 'info' | 'warn' | 'error'; message: string }
  | { t: 'ping'; id: number; ts: number }
  | { t: 'error'; code: ErrorCode; message: string };

// ---------------------------------------------------------------------------
// Norns  ⇄  relay
// ---------------------------------------------------------------------------

export type NornsIn =
  | { t: 'hello'; nornsToken: string; firmware?: string }
  /** Periodic report driving the host's supervision panel. */
  | { t: 'status'; status: Omit<NornsStatus, 'online'> }
  /** K3 double-tap / release. Cuts the session from the hardware side. */
  | { t: 'kill' }
  | { t: 'arm' }
  /** K2 on the Norns opens registrations or fires the draw (PRD §12). */
  | { t: 'open' }
  | { t: 'draw'; countdownMs?: number }
  /** E1/E2/E3 turned on the device. */
  | { t: 'config'; patch: Record<string, unknown> }
  /** Latency probe echo: how long the gesture took to reach the device. */
  | { t: 'latency'; grantId: string; seq: number; ms: number }
  | { t: 'pong'; id: number; ts: number };

export type NornsOut =
  | { t: 'welcome'; sessionId: string; config: SessionConfig; state: PublicState }
  | { t: 'config'; config: SessionConfig }
  | { t: 'state'; state: PublicState }
  /** A grant became active: values that follow are authorised until `expiresAt`. */
  | { t: 'grant'; grantId: string; expiresAt: number; pad: { x: number; y: number } }
  /**
   * A validated pad sample.
   * `x`/`y` are normalised 0..1, `originTs` is server-time-corrected so the
   * Norns can compute the true end-to-end latency and drop stale frames.
   */
  | { t: 'xy'; grantId: string; seq: number; x: number; y: number; originTs: number; relayTs: number }
  /** Control window over — apply the configured safe behaviour. */
  | { t: 'end'; reason: EndReason; behavior: 'return-safe' | 'hold' }
  /** Relay-side kill propagated to the device. */
  | { t: 'kill' }
  | { t: 'ping'; id: number; ts: number }
  | { t: 'error'; code: ErrorCode; message: string };

// ---------------------------------------------------------------------------
// Stage (public, read-only)
// ---------------------------------------------------------------------------

export type StageOut =
  | { t: 'state'; state: PublicState }
  | { t: 'ping'; id: number; ts: number };

// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'bad_message'
  | 'bad_session'
  | 'bad_token'
  | 'not_authorised'
  | 'expired'
  | 'revoked'
  | 'rate_limited'
  | 'bad_state'
  | 'blocked'
  | 'session_full'
  | 'server_error';
