/**
 * Name moderation.
 *
 * A stage name is now always shown, and the public view is a projection surface
 * and possibly a stream (FR-15). That makes the field a broadcast input: somebody
 * will type an insult, and it would land on the screen behind the artists.
 *
 * Enforced here, in shared code the **relay** runs, because a browser-side check
 * is worthless — a participant can open a WebSocket and send `{t:'pseudo'}`
 * directly.
 *
 * Two design choices worth stating:
 *
 *  - **Obfuscation is normalised away, not enumerated.** `5@l0pe`, `s a l o p e`
 *    and `salooope` all collapse to the same string before matching, so the list
 *    stays short instead of racing every spelling.
 *  - **A match is not an error.** The relay silently substitutes a clean
 *    assigned name and tells the host. Rejecting with "that word is banned"
 *    hands the author a tuning oracle, and they will find a spelling that gets
 *    through before the draw fires.
 *
 * This list is a floor, not a policy. It is deliberately small and biased toward
 * missing things rather than blocking innocent names, and it should be reviewed
 * by whoever is on stage — they carry the consequence.
 */

export type ModerationCategory = 'profanity' | 'slur' | 'impersonation' | 'promotion';

export interface ModerationVerdict {
  blocked: boolean;
  category?: ModerationCategory;
  /** For the host journal. Never sent to the participant. */
  reason?: string;
}

/**
 * Characters people substitute to slip past a filter. Applied after diacritics
 * are stripped, so `à`→`a` is already handled.
 */
const CONFUSABLES: Record<string, string> = {
  // digits and symbols
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't', '(': 'c', '€': 'e', '£': 'l',
  // Cyrillic and Greek lookalikes
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ο: 'o', ρ: 'p', σ: 's', τ: 't', υ: 'y', χ: 'x',
};

/**
 * Collapse a name to a comparable form: no diacritics, no case, no lookalikes,
 * no doubled letters. `keepSpaces` preserves word boundaries for the matches
 * that need them.
 */
function normalise(input: string, keepSpaces: boolean): string {
  const folded = input
    .normalize('NFD')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[̀-ͯ]/g, '') // combining accents
    .toLowerCase()
    .split('')
    .map((char) => CONFUSABLES[char] ?? char)
    .join('');

  const stripped = keepSpaces
    ? folded.replace(/[^a-z\s]+/g, ' ').replace(/\s+/g, ' ').trim()
    : folded.replace(/[^a-z]+/g, '');

  // "salooope" and "salope" must not be different problems.
  return stripped.replace(/([a-z])\1+/g, '$1');
}

/**
 * Terms that cannot appear inside an innocent name, so a substring match on the
 * separator-free form is safe. This is what catches `s.a.l.o.p.e`.
 */
const HARD_TERMS = [
  // fr
  'salope', 'salaud', 'connard', 'conard', 'conasse', 'connasse', 'encule', 'enculer',
  'enfoire', 'batard', 'putain', 'pouffiasse', 'branleur', 'couille', 'niquetamere',
  'ntm', 'fdp', 'tgueule', 'ferlagueule', 'pedophile', 'zoophile',
  // en
  'fuck', 'fucker', 'fucking', 'motherfucker', 'bitch', 'asshole', 'bastard', 'cunt',
  'wanker', 'dickhead', 'blowjob', 'rape', 'rapist',
  // slurs — kept separate below only for reporting; matching is identical
  'nigger', 'nigga', 'negro', 'faggot', 'tranny', 'retard', 'bougnoule', 'youpin',
  'niakoue', 'chinetoque', 'pede', 'tapette', 'gouine', 'feuj', 'macaque', 'kike', 'chink',
];

const SLUR_TERMS = new Set([
  'nigger', 'nigga', 'negro', 'faggot', 'tranny', 'retard', 'bougnoule', 'youpin',
  'niakoue', 'chinetoque', 'pede', 'tapette', 'gouine', 'feuj', 'macaque', 'kike', 'chink',
]);

/**
 * Ambiguous as substrings — `pute` sits inside `dispute`, `con` inside dozens of
 * ordinary words — so these only match as whole words.
 */
const WORD_TERMS = [
  'pute', 'merde', 'merdeux', 'chier', 'chiante', 'cul', 'bite', 'nique', 'niquer',
  'salopard', 'shit', 'piss', 'dick', 'cock', 'slut', 'whore', 'anal', 'porn', 'sexe', 'sex',
];

/**
 * Names that would let someone pose as the artists, the crew, or the platform on
 * a screen the audience trusts. Matched on the whole name, never as a substring:
 * blocking `host` as a fragment would reject `Hostile`.
 */
const RESERVED = [
  'ramas', 'stagein', 'admin', 'administrateur', 'administrator', 'moderateur', 'moderator',
  'modo', 'mod', 'staff', 'officiel', 'official', 'organisateur', 'organizer', 'host', 'hote',
  'artiste', 'artist', 'systeme', 'system', 'root', 'null', 'undefined', 'anonyme', 'sansnom',
];

/** Names that exist only to advertise something to the room. */
const PROMOTION =
  /(https?:\/\/|www\.|\.com|\.fr|\.net|\.io|\.tv|t\.me|twitch|tiktok|insta|onlyfans|discord\.gg|@\w{2,})/i;

/**
 * Innocent names that the rules above would otherwise catch. Checked first, so
 * a real person is never told their name is unavailable because of a substring.
 */
const ALLOWLIST_RAW = ['sexton', 'analyse', 'analytique', 'cocktail', 'cockpit'];

/**
 * Every list is normalised through the *same* function as the input, at load.
 *
 * Skipping this silently disables any term with a doubled letter: `nigger`
 * collapses to `niger` on the way in, so a list holding the literal spelling
 * never matches. That failure is invisible — the filter reports success while
 * passing the worst words through.
 */
const squash = (term: string): string => normalise(term, false);

const HARD_NORMALISED = [...new Set(HARD_TERMS.map(squash))].filter(Boolean);
const SLUR_NORMALISED = new Set([...SLUR_TERMS].map(squash));
const WORD_NORMALISED = new Set(WORD_TERMS.map(squash));
const RESERVED_NORMALISED = new Set(RESERVED.map(squash));
const ALLOWLIST = new Set(ALLOWLIST_RAW.map(squash));

export function moderateName(input: string): ModerationVerdict {
  const raw = String(input ?? '');
  if (raw.trim() === '') return { blocked: false };

  if (PROMOTION.test(raw)) {
    return { blocked: true, category: 'promotion', reason: 'looks like a link or a handle' };
  }

  const spaced = normalise(raw, true);
  const squashed = normalise(raw, false);
  const words = spaced.split(' ').filter(Boolean);

  if (words.every((word) => ALLOWLIST.has(word))) return { blocked: false };

  if (RESERVED_NORMALISED.has(squashed) || words.some((word) => RESERVED_NORMALISED.has(word))) {
    return { blocked: true, category: 'impersonation', reason: `reserved name "${squashed}"` };
  }

  for (const term of HARD_NORMALISED) {
    if (squashed.includes(term)) {
      return {
        blocked: true,
        category: SLUR_NORMALISED.has(term) ? 'slur' : 'profanity',
        reason: `matched "${term}"`,
      };
    }
  }

  for (const word of words) {
    if (WORD_NORMALISED.has(word)) {
      return { blocked: true, category: 'profanity', reason: `matched word "${word}"` };
    }
  }

  return { blocked: false };
}
