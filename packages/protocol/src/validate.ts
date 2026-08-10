/**
 * Explicit schema validation for every inbound frame (PRD §11, NFR-06).
 *
 * Hand-written rather than schema-library-driven on purpose: the message set is
 * small and closed, and every rejection maps to a precise error code we can log
 * and rate-limit on.
 */

import { clamp, clampInt } from './dsp';
import type { HostIn, NornsIn, NornsStatus, ParticipantIn } from './messages';
import { LIMITS, PRESETS, applyPreset, type SessionConfig } from './session';

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function bad(error: string): Validated<never> {
  return { ok: false, error };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, max = 64): string | null {
  if (typeof v !== 'string') return null;
  if (v.length > max) return null;
  return v;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parse a JSON frame with a hard size limit before it reaches any handler. */
export function parseFrame(raw: string | Buffer, maxBytes = 4096): Validated<Record<string, unknown>> {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.length > maxBytes) return bad('frame too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad('not json');
  }
  if (!isRecord(parsed)) return bad('not an object');
  if (typeof parsed.t !== 'string') return bad('missing t');
  return { ok: true, value: parsed };
}

/**
 * Pseudonyms are optional and public-facing: strip control characters, collapse
 * whitespace, cap the length so nothing can break the stage view (PRD §15).
 */
export function sanitizePseudo(input: unknown, fallback = ''): string {
  if (typeof input !== 'string') return fallback;
  const cleaned = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return cleaned || fallback;
}

/** Client ids come from the browser: accept only opaque url-safe tokens. */
export function sanitizeClientId(input: unknown): string | null {
  const s = str(input, 64);
  if (!s) return null;
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
}

export function validateParticipantIn(m: Record<string, unknown>): Validated<ParticipantIn> {
  switch (m.t) {
    case 'hello': {
      const clientId = sanitizeClientId(m.clientId);
      if (!clientId) return bad('bad clientId');
      return { ok: true, value: { t: 'hello', clientId, pseudo: sanitizePseudo(m.pseudo) } };
    }
    case 'enter':
      return { ok: true, value: { t: 'enter' } };
    case 'leave':
      return { ok: true, value: { t: 'leave' } };
    case 'pseudo':
      return { ok: true, value: { t: 'pseudo', pseudo: sanitizePseudo(m.pseudo) } };
    case 'activate': {
      const grantToken = str(m.grantToken, 128);
      if (!grantToken) return bad('bad grantToken');
      return { ok: true, value: { t: 'activate', grantToken } };
    }
    case 'xy': {
      const grantToken = str(m.grantToken, 128);
      const x = num(m.x);
      const y = num(m.y);
      const seq = num(m.seq);
      const ts = num(m.ts);
      if (!grantToken) return bad('bad grantToken');
      if (x === null || y === null) return bad('bad coordinates');
      if (seq === null || seq < 0 || !Number.isInteger(seq)) return bad('bad seq');
      if (ts === null) return bad('bad ts');
      // Bound server-side, exactly as the Norns will do again (NFR-07).
      return {
        ok: true,
        value: { t: 'xy', grantToken, x: clamp(x, 0, 1), y: clamp(y, 0, 1), seq, ts },
      };
    }
    case 'pong': {
      const id = num(m.id);
      const ts = num(m.ts);
      if (id === null || ts === null) return bad('bad pong');
      return { ok: true, value: { t: 'pong', id, ts } };
    }
    default:
      return bad(`unknown type ${String(m.t)}`);
  }
}

export function validateHostIn(m: Record<string, unknown>): Validated<HostIn> {
  switch (m.t) {
    case 'hello': {
      const hostToken = str(m.hostToken, 128);
      if (!hostToken) return bad('bad hostToken');
      return { ok: true, value: { t: 'hello', hostToken } };
    }
    case 'open':
    case 'close':
    case 'reset':
    case 'revoke':
    case 'kill':
    case 'unkill':
    case 'rotate':
      return { ok: true, value: { t: m.t } as HostIn };
    case 'draw': {
      const countdownMs = num(m.countdownMs);
      return {
        ok: true,
        value: { t: 'draw', ...(countdownMs === null ? {} : { countdownMs: clamp(countdownMs, 0, 60_000) }) },
      };
    }
    case 'config': {
      if (!isRecord(m.patch)) return bad('bad patch');
      return { ok: true, value: { t: 'config', patch: m.patch } };
    }
    case 'block': {
      const clientId = sanitizeClientId(m.clientId);
      if (!clientId) return bad('bad clientId');
      return { ok: true, value: { t: 'block', clientId } };
    }
    case 'hideNames':
      return { ok: true, value: { t: 'hideNames', hidden: Boolean(m.hidden) } };
    case 'pong': {
      const id = num(m.id);
      const ts = num(m.ts);
      if (id === null || ts === null) return bad('bad pong');
      return { ok: true, value: { t: 'pong', id, ts } };
    }
    default:
      return bad(`unknown type ${String(m.t)}`);
  }
}

/**
 * The MIDI port the device reports sending through. A script old enough not to
 * know about ports simply omits it, which is not the same claim as "a port with
 * nothing behind it" — so anything unreadable stays null and lets the preflight
 * say "unknown" instead of crying wolf.
 */
function midiPort(v: unknown): NornsStatus['midiPort'] {
  if (!isRecord(v)) return null;
  const index = num(v.index);
  if (index === null) return null;
  return {
    index: clampInt(index, 1, 16),
    name: str(v.name, 32) ?? 'none',
    live: Boolean(v.live),
  };
}

export function validateNornsIn(m: Record<string, unknown>): Validated<NornsIn> {
  switch (m.t) {
    case 'hello': {
      const nornsToken = str(m.nornsToken, 128);
      if (!nornsToken) return bad('bad nornsToken');
      const firmware = str(m.firmware, 32) ?? undefined;
      return { ok: true, value: { t: 'hello', nornsToken, ...(firmware ? { firmware } : {}) } };
    }
    case 'status': {
      if (!isRecord(m.status)) return bad('bad status');
      const s = m.status;
      return {
        ok: true,
        value: {
          t: 'status',
          status: {
            armed: Boolean(s.armed),
            killed: Boolean(s.killed),
            preset: str(s.preset, 32) ?? 'unknown',
            targetX: clamp(num(s.targetX) ?? 0, 0, 1),
            targetY: clamp(num(s.targetY) ?? 0, 0, 1),
            outX: clamp(num(s.outX) ?? 0, 0, 1),
            outY: clamp(num(s.outY) ?? 0, 0, 1),
            ccX: clampInt(num(s.ccX) ?? 0, 0, 127),
            ccY: clampInt(num(s.ccY) ?? 0, 0, 127),
            midiBackend: str(s.midiBackend, 32) ?? 'log',
            midiPort: midiPort(s.midiPort),
            lastMessageAt: num(s.lastMessageAt),
            rejected: Math.max(0, Math.trunc(num(s.rejected) ?? 0)),
          },
        },
      };
    }
    case 'kill':
    case 'arm':
    case 'open':
      return { ok: true, value: { t: m.t } as NornsIn };
    case 'draw': {
      const countdownMs = num(m.countdownMs);
      return {
        ok: true,
        value: { t: 'draw', ...(countdownMs === null ? {} : { countdownMs: clamp(countdownMs, 0, 60_000) }) },
      };
    }
    case 'config': {
      if (!isRecord(m.patch)) return bad('bad patch');
      return { ok: true, value: { t: 'config', patch: m.patch } };
    }
    case 'latency': {
      const grantId = str(m.grantId, 64);
      const seq = num(m.seq);
      const ms = num(m.ms);
      if (!grantId || seq === null || ms === null) return bad('bad latency');
      return { ok: true, value: { t: 'latency', grantId, seq, ms } };
    }
    case 'pong': {
      const id = num(m.id);
      const ts = num(m.ts);
      if (id === null || ts === null) return bad('bad pong');
      return { ok: true, value: { t: 'pong', id, ts } };
    }
    default:
      return bad(`unknown type ${String(m.t)}`);
  }
}

// ---------------------------------------------------------------------------
// Configuration patching
// ---------------------------------------------------------------------------

function macroPatch(
  current: SessionConfig['macros']['x'],
  patch: unknown,
): SessionConfig['macros']['x'] {
  if (!isRecord(patch)) return current;
  const next = { ...current };
  const name = str(patch.name, 24);
  if (name !== null) next.name = sanitizePseudo(name, current.name);
  const cc = num(patch.cc);
  if (cc !== null) next.cc = clampInt(cc, LIMITS.cc[0], LIMITS.cc[1]);
  const channel = num(patch.channel);
  if (channel !== null) next.channel = clampInt(channel, LIMITS.channel[0], LIMITS.channel[1]);
  const min = num(patch.min);
  if (min !== null) next.min = clampInt(min, LIMITS.ccValue[0], LIMITS.ccValue[1]);
  const max = num(patch.max);
  if (max !== null) next.max = clampInt(max, LIMITS.ccValue[0], LIMITS.ccValue[1]);
  const safe = num(patch.safe);
  if (safe !== null) next.safe = clampInt(safe, LIMITS.ccValue[0], LIMITS.ccValue[1]);
  if (typeof patch.invert === 'boolean') next.invert = patch.invert;
  const osc = str(patch.osc, 64);
  if (osc !== null && /^\/[\w/-]{0,63}$/.test(osc)) next.osc = osc;
  return next;
}

/**
 * Merge a host/Norns configuration patch into a config, clamping every field to
 * {@link LIMITS}. Unknown keys are ignored. Never throws.
 */
export function applyConfigPatch(config: SessionConfig, patch: Record<string, unknown>): SessionConfig {
  let next: SessionConfig = { ...config, macros: { x: { ...config.macros.x }, y: { ...config.macros.y } } };

  const preset = str(patch.preset, 32);
  if (preset !== null && PRESETS[preset]) next = applyPreset(next, preset);

  const numeric: Array<[keyof typeof LIMITS & keyof SessionConfig, readonly [number, number]]> = [
    ['controlDurationMs', LIMITS.controlDurationMs],
    ['activationTimeoutMs', LIMITS.activationTimeoutMs],
    ['rateHz', LIMITS.rateHz],
    ['slewMs', LIMITS.slewMs],
    ['maxRatePerSec', LIMITS.maxRatePerSec],
    ['disconnectGraceMs', LIMITS.disconnectGraceMs],
  ];
  for (const [key, [lo, hi]] of numeric) {
    const v = num(patch[key]);
    if (v !== null) (next as unknown as Record<string, number>)[key] = clamp(v, lo, hi);
  }

  if (typeof patch.autoRedrawOnNoShow === 'boolean') next.autoRedrawOnNoShow = patch.autoRedrawOnNoShow;
  if (typeof patch.winnerCanRewin === 'boolean') next.winnerCanRewin = patch.winnerCanRewin;
  if (typeof patch.hideNames === 'boolean') next.hideNames = patch.hideNames;
  if (typeof patch.requireJoinKey === 'boolean') next.requireJoinKey = patch.requireJoinKey;
  if (patch.padStart === 'center' || patch.padStart === 'safe' || patch.padStart === 'last') {
    next.padStart = patch.padStart;
  }
  if (patch.endBehavior === 'return-safe' || patch.endBehavior === 'hold') {
    next.endBehavior = patch.endBehavior;
  }

  if (isRecord(patch.macros)) {
    next.macros.x = macroPatch(next.macros.x, patch.macros.x);
    next.macros.y = macroPatch(next.macros.y, patch.macros.y);
  }

  return next;
}
