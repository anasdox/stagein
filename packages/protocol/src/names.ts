/**
 * Stage names.
 *
 * The pseudonym is entered before joining the lottery, but PRD §13 wants a
 * median of under 20 s between scanning and registering — and a text field is
 * the slowest interaction a phone can ask for, in a dark room, one-handed.
 *
 * So the relay hands every device a usable name up front. Nobody has to type,
 * anybody can type over it, and the public view never has to announce
 * "anonyme" — which would flatten the one moment the whole ritual exists for
 * (§4: the audience sees who is on stage).
 *
 * Assigned rather than derived: no device fingerprint, no real name encouraged,
 * nothing collected (NFR-08).
 */

import { randomInt } from 'node:crypto';

/** Evocative, short, pronounceable out loud by a host, and never insulting. */
const NOUNS = [
  'Comète',
  'Braise',
  'Écho',
  'Orage',
  'Vent',
  'Prisme',
  'Néon',
  'Halo',
  'Silex',
  'Onyx',
  'Vertige',
  'Aurore',
  'Cyan',
  'Mirage',
  'Vague',
  'Cendre',
  'Zéphyr',
  'Quartz',
  'Sillage',
  'Éclat',
  'Nadir',
  'Zénith',
  'Ombre',
  'Foudre',
] as const;

/** Two digits keeps it inside the 20-character cap with room to spare. */
function candidate(): string {
  const noun = NOUNS[randomInt(NOUNS.length)]!;
  return `${noun} ${randomInt(2, 100)}`;
}

/**
 * A stage name not already in use.
 *
 * @param taken names already handed out in this session, compared
 *   case-insensitively so two people are never announced identically
 */
export function generateStageName(taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((name) => name.trim().toLowerCase()));
  for (let attempt = 0; attempt < 24; attempt++) {
    const name = candidate();
    if (!used.has(name.toLowerCase())) return name;
  }
  // A 200-participant session cannot exhaust 24 nouns x 98 numbers, but never
  // fail to produce a name: an unnamed participant breaks the stage view.
  return `${NOUNS[randomInt(NOUNS.length)]!} ${randomInt(100, 1000)}`;
}
