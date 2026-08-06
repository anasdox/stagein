/**
 * Musical safety maths, shared by the relay (validation) and the Norns client
 * (clamp + slew + mapping). PRD §7: the Norns applies these even though the
 * relay already validated — so the code lives here and runs on both sides.
 */

import type { MacroConfig } from './session';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Clamp into an inclusive integer range. */
export function clampInt(v: number, lo: number, hi: number): number {
  return Math.round(clamp(v, lo, hi));
}

/**
 * One step of the smoothing chain.
 *
 * Two stages, both required by PRD §8:
 *  1. a one-pole ramp so the value glides instead of stepping (`slewMs`);
 *  2. a hard per-second speed cap, so even a teleporting input (packet loss,
 *     a finger jumping across the pad) cannot produce a jump.
 *
 * `slewMs` is read as the time to cover ~95 % of the distance, hence tau = t/3.
 *
 * @param current  present output, normalised 0..1
 * @param target   requested output, normalised 0..1
 * @param dtSec    elapsed time since the previous step, in seconds
 */
export function slewStep(
  current: number,
  target: number,
  dtSec: number,
  slewMs: number,
  maxRatePerSec: number,
): number {
  if (dtSec <= 0) return current;
  const tau = Math.max(slewMs, 1) / 1000 / 3;
  const alpha = 1 - Math.exp(-dtSec / tau);
  let next = current + (target - current) * alpha;

  const maxDelta = maxRatePerSec * dtSec;
  next = clamp(next, current - maxDelta, current + maxDelta);

  // Snap when we are within half a CC step, otherwise the one-pole tail
  // dribbles forever and the Norns never settles on the safe value.
  if (Math.abs(target - next) < 1 / 512) next = target;
  return clamp01(next);
}

/** Map a normalised 0..1 position to the macro's authorised CC range. */
export function mapToCc(norm: number, macro: MacroConfig): number {
  const lo = Math.min(macro.min, macro.max);
  const hi = Math.max(macro.min, macro.max);
  const n = macro.invert ? 1 - clamp01(norm) : clamp01(norm);
  return clampInt(lo + n * (hi - lo), 0, 127);
}

/** Inverse of {@link mapToCc}: where does a CC value sit on the pad? */
export function ccToNorm(cc: number, macro: MacroConfig): number {
  const lo = Math.min(macro.min, macro.max);
  const hi = Math.max(macro.min, macro.max);
  if (hi === lo) return 0;
  const n = clamp01((clamp(cc, lo, hi) - lo) / (hi - lo));
  return macro.invert ? 1 - n : n;
}

/** Rolling percentile tracker used for the NFR-01 latency budget. */
export class Percentile {
  private samples: number[] = [];
  constructor(private readonly capacity = 512) {}

  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.samples.push(v);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  get count(): number {
    return this.samples.length;
  }

  quantile(q: number): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = clamp(Math.ceil(q * sorted.length) - 1, 0, sorted.length - 1);
    return sorted[idx] ?? null;
  }

  get p50(): number | null {
    return this.quantile(0.5);
  }

  get p95(): number | null {
    return this.quantile(0.95);
  }
}

/**
 * Token bucket, used for per-connection rate limiting (NFR-06).
 * Sized from the configured event rate with headroom for jitter/bursts.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number, cost = 1): boolean {
    const dt = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSec);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}
