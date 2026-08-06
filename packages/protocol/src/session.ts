/**
 * Session state machine and configuration model.
 *
 * PRD §9.2 defines six states. The relay is the single authority for
 * transitions; hosts, participants and the Norns only ever *request* them.
 */

export const SESSION_STATES = [
  'CLOSED',
  'OPEN',
  'DRAWING',
  'AWARDED',
  'ACTIVE',
  'ENDED',
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

/** Allowed transitions, straight from PRD §9.2. */
export const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  CLOSED: ['OPEN'],
  OPEN: ['DRAWING', 'CLOSED'],
  DRAWING: ['AWARDED', 'CLOSED'],
  AWARDED: ['ACTIVE', 'ENDED'],
  ACTIVE: ['ENDED'],
  ENDED: ['OPEN', 'CLOSED'],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Why a control window stopped. Drives the Norns end-of-session behaviour. */
export type EndReason =
  | 'expired' // the authorised duration elapsed (the normal case)
  | 'revoked' // host pressed "revoke"
  | 'killed' // kill switch, host side or Norns side
  | 'no_show' // winner never touched the pad within the activation delay
  | 'disconnected' // winner's phone dropped past the grace window
  | 'reset'; // host reset the session

/** One controllable macro: X or Y. Ranges are MIDI CC values (0..127). */
export interface MacroConfig {
  /** Human label shown on the host UI, the stage view and the Norns screen. */
  name: string;
  /** MIDI CC number. */
  cc: number;
  /** MIDI channel, 1..16. */
  channel: number;
  /** Lower bound of the authorised range. */
  min: number;
  /** Upper bound of the authorised range. */
  max: number;
  /** Invert the mapping (pad up = value down). */
  invert: boolean;
  /**
   * Value the Norns falls back to when nobody is authorised, expressed in the
   * same 0..127 space. PRD §7: "revient progressivement au preset sûr".
   */
  safe: number;
  /** OSC address used when the Norns runs in OSC mode. */
  osc: string;
}

export interface SessionConfig {
  /** PRD §8: 30 s default, configurable 10..60 s. */
  controlDurationMs: number;
  /** PRD §16: winner has 10 s to touch the pad, else redraw. */
  activationTimeoutMs: number;
  /** PRD §8: 15 events/s maximum from the phone. */
  rateHz: number;
  /** PRD §8: 100..500 ms ramp applied on the Norns. */
  slewMs: number;
  /** Hard cap on movement speed, in normalised units per second. */
  maxRatePerSec: number;
  /** How long a winner may be disconnected before the grant dies. */
  disconnectGraceMs: number;
  /** Redraw automatically when the winner does not show up. */
  autoRedrawOnNoShow: boolean;
  /** PRD §17 open question — made explicit and configurable. */
  winnerCanRewin: boolean;
  /** PRD §17 open question — where the pad dot starts. */
  padStart: 'center' | 'safe' | 'last';
  /** PRD §8: end of session behaviour. */
  endBehavior: 'return-safe' | 'hold';
  /**
   * Hide participant names from the public view. The operator's backstop for
   * anything the name filter lets through, mid-set, without a restart.
   */
  hideNames: boolean;
  /** Preset label, selected with E1 on the Norns. */
  preset: string;
  macros: { x: MacroConfig; y: MacroConfig };
}

export const PRESETS: Record<string, { x: Partial<MacroConfig>; y: Partial<MacroConfig> }> = {
  // PRD §18 recommended first test: X = filter opening, Y = delay amount.
  'filter+delay': {
    x: { name: 'Filter', cc: 74, min: 30, max: 100, safe: 64, osc: '/stagein/filter' },
    y: { name: 'Delay', cc: 91, min: 0, max: 70, safe: 10, osc: '/stagein/delay' },
  },
  'filter+reverb': {
    x: { name: 'Filter', cc: 74, min: 30, max: 100, safe: 64, osc: '/stagein/filter' },
    y: { name: 'Reverb', cc: 93, min: 0, max: 80, safe: 12, osc: '/stagein/reverb' },
  },
  'texture+space': {
    x: { name: 'Texture', cc: 71, min: 20, max: 110, safe: 50, osc: '/stagein/texture' },
    y: { name: 'Space', cc: 93, min: 0, max: 90, safe: 8, osc: '/stagein/space' },
  },
};

export function defaultConfig(): SessionConfig {
  return {
    controlDurationMs: 30_000,
    activationTimeoutMs: 10_000,
    rateHz: 15,
    slewMs: 250,
    maxRatePerSec: 2,
    disconnectGraceMs: 3_000,
    autoRedrawOnNoShow: true,
    winnerCanRewin: false,
    padStart: 'center',
    endBehavior: 'return-safe',
    hideNames: false,
    preset: 'filter+delay',
    macros: {
      x: {
        name: 'Filter',
        cc: 74,
        channel: 1,
        min: 30,
        max: 100,
        invert: false,
        safe: 64,
        osc: '/stagein/filter',
      },
      y: {
        name: 'Delay',
        cc: 91,
        channel: 1,
        min: 0,
        max: 70,
        invert: false,
        safe: 10,
        osc: '/stagein/delay',
      },
    },
  };
}

/** Apply a named preset on top of a config, keeping channel/invert choices. */
export function applyPreset(config: SessionConfig, preset: string): SessionConfig {
  const p = PRESETS[preset];
  if (!p) return config;
  return {
    ...config,
    preset,
    macros: {
      x: { ...config.macros.x, ...p.x },
      y: { ...config.macros.y, ...p.y },
    },
  };
}

/**
 * Configuration bounds. Anything a host sends is clamped through this, so a
 * malformed or hostile host UI cannot widen the musical envelope past what the
 * PRD allows (§8, NFR-07).
 */
export const LIMITS = {
  controlDurationMs: [10_000, 60_000],
  activationTimeoutMs: [3_000, 60_000],
  rateHz: [5, 30],
  slewMs: [50, 2_000],
  maxRatePerSec: [0.1, 20],
  disconnectGraceMs: [0, 30_000],
  cc: [0, 127],
  channel: [1, 16],
  ccValue: [0, 127],
} as const;
