import { randomBytes, randomInt } from 'node:crypto';

/**
 * Session codes are read aloud and typed on phones, so the alphabet drops the
 * characters people confuse: I, O, 0, 1.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function sessionCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Opaque, non-guessable token (PRD §11). */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/** Uniform pick — crypto RNG so the draw cannot be predicted or biased. */
export function pickOne<T>(items: readonly T[]): T | null {
  if (items.length === 0) return null;
  return items[randomInt(items.length)] ?? null;
}

/** Constant-time-ish token comparison. */
export function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
