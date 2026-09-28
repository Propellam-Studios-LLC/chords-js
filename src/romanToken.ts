/**
 * Roman-numeral chords as **input vocabulary** — the reading half of what
 * `chart.romanSymbol` / `convertBars.absoluteBarsToRoman` already write.
 *
 * Roman-numeral chords are first-class vocabulary in this library, on a par
 * with absolute symbols: `parseChordToken` accepts only absolute roots (A–G),
 * and this module is the equivalent parser for tokens such as `ii7` or `bVII`,
 * so callers do not need to pre-translate Roman input themselves.
 *
 * The correctness criterion is a **round trip**: for every canonical chord
 * type, parsing what `romanSymbol` renders must reproduce the same degree and
 * canonical type. That property is what forces the case-aware suffix rule
 * below, and it is checked exhaustively in `test/romanToken.test.ts`.
 *
 * The grammar:
 *
 * ```
 * romanToken   := accidental* numeral suffix? bassPart? durationTail?
 * accidental   := 'b' | '#'
 * numeral      := 'I'|'II'|'III'|'IV'|'V'|'VI'|'VII'   (major-family)
 *               | 'i'|'ii'|'iii'|'iv'|'v'|'vi'|'vii'   (minor-family)
 * suffix       := any alias or display spelling of a chord type
 * bassPart     := '/' accidental* numeral              (slash bass)
 * durationTail := the existing `.chords` duration syntax
 * ```
 *
 * Three deliberate design rules (not bugs to be "fixed"):
 *
 * 1. **`/X` after a numeral is a slash BASS, not a secondary dominant.** That
 *    is what `romanSymbol` already emits (`V7/I`), and round-tripping with the
 *    library's own output takes priority. Tonicization (`V/V`, `viio/vi`) has
 *    no notation in this vocabulary and **cannot be flagged as an error** — the
 *    token parses, just not as a musician might intend. Applications that
 *    accept Roman input should point this out to their users.
 * 2. **An arabic suffix is a chord TYPE, not figured bass.** `IV6` is a major
 *    sixth chord, exactly as `C6` is; first inversion is written as slash bass
 *    (`IV/VI`). This surprises a classically-trained reader and cannot be
 *    detected as an error, so it is documented rather than guessed at.
 * 3. **Case and suffix must agree.** `Im7` is REJECTED — with a suggestion of
 *    the spelling that was probably meant (`i7`), because the same machinery
 *    that detects the disagreement already knows the correct spelling.
 */

import { ChordVocabulary, loadVocabulary } from './chordTypes.js';
import { displaySuffixFor } from './chordSymbol.js';
import {
  ChordParseError,
  NO_CHORD,
  NoChord,
  parseDuration,
  VALID_TAIL_RE,
} from './parseChord.js';

/** A parsed Roman-numeral chord. */
export interface ParsedRomanChord {
  /** The raw token as written, incl. any duration suffix (e.g. `ii7/2`). */
  token: string;
  /**
   * The cased numeral **with its accidental prefix already attached** —
   * `'ii'`, `'bVII'`, `'#iv'`.
   *
   * Deliberately not split into numeral + accidental the way [ParsedChord]
   * splits `root`/`rootAcc`: in Roman the accidental is a *prefix* and in
   * absolute it is a *suffix*, so mirroring that field pair would invert its
   * position. This is the same string `absoluteBarsToRoman` puts in
   * `SimpleChord.root` and `chart.romanSymbol` consumes as `degree`.
   */
  degree: string;
  /** Canonical chord type, e.g. `min7`. */
  canonical: string;
  /** Slash-bass degree, always UPPERCASE (e.g. `V`, `bVI`), or null. */
  bassDegree: string | null;
  /** Duration in `L:` units (a bare chord = 1.0; `/2` = 0.5). */
  units: number;
  /** The chord as written, WITHOUT the duration suffix (e.g. `ii7/V`). */
  symbol: string;
}

/** Numerals longest-first so `VII` beats `VI` beats `V`. */
const NUMERALS_UPPER = ['VII', 'VI', 'V', 'IV', 'III', 'II', 'I'];
const NUMERALS_LOWER = ['vii', 'vi', 'v', 'iv', 'iii', 'ii', 'i'];
const NUMERAL_RE = new RegExp(
  `^([b#]*)(${[...NUMERALS_UPPER, ...NUMERALS_LOWER].join('|')})`,
);
const ROMAN_BASS_RE = new RegExp(
  `^\\/([b#]*)(${[...NUMERALS_UPPER, ...NUMERALS_LOWER].join('|')})`,
);

/**
 * Triad qualities that REQUIRE a lowercase numeral, and those that require an
 * uppercase one. `suspended` is in neither: a suspended chord has no third, so
 * its case carries no information and both spellings are accepted.
 */
const REQUIRES_LOWERCASE = new Set(['minor', 'diminished']);
const REQUIRES_UPPERCASE = new Set(['major', 'augmented']);

let _displayToCanonical: Map<string, string> | null = null;

/**
 * The display-spelling table, inverted from {@link displaySuffixFor} over the
 * whole vocabulary.
 *
 * It exists so that everything the renderer can *emit* can also be *read* —
 * `m(maj7)` for `minmaj7` is the one spelling the alias table genuinely lacks.
 * Built by inversion rather than hand-written, so it can never drift from the
 * renderer it is the inverse of.
 */
function displayToCanonical(vocab: ChordVocabulary): Map<string, string> {
  if (_displayToCanonical) return _displayToCanonical;
  const map = new Map<string, string>();
  for (const canonical of vocab.entryByCanonical.keys()) {
    const display = displaySuffixFor(canonical);
    if (!map.has(display)) map.set(display, canonical);
    // The renderer drops a leading `m` from `min*` suffixes on a lowercase
    // numeral, so that stripped form must read back too (`(maj7)` → minmaj7).
    if (canonical.startsWith('min')) {
      const stripped = display.replace(/^m/, '');
      if (stripped !== display && !map.has(stripped)) {
        map.set(stripped, canonical);
      }
    }
  }
  _displayToCanonical = map;
  return map;
}

/**
 * Resolve a Roman suffix to a canonical chord type, honouring the numeral's
 * case.
 *
 * The rule inverts what `romanSymbol` does: it strips a leading `m` from a
 * `min*` suffix because the lowercase numeral already says "minor". So D minor
 * seventh in C renders `ii7`, while G dominant seventh renders `V7` — and a
 * naive alias lookup on `7` returns `dom7` for both. Hence:
 *
 * - **lowercase numeral:** try `'m' + suffix` first, then the suffix as
 *   written, then the display-spelling table;
 * - **uppercase numeral:** try the suffix as written, then the display table.
 *
 * Returns null when nothing in the vocabulary matches.
 */
export function romanSuffixToCanonical(
  suffix: string,
  lowercase: boolean,
  vocab: ChordVocabulary = loadVocabulary(),
): string | null {
  const tryAlias = (s: string): string | null =>
    vocab.aliasToCanonical.get(s) ?? null;
  if (lowercase) {
    const withM = tryAlias(`m${suffix}`);
    if (withM !== null) return withM;
  }
  const plain = tryAlias(suffix);
  if (plain !== null) return plain;
  return displayToCanonical(vocab).get(suffix) ?? null;
}

/** True if `tail` is a valid (possibly empty) Roman slash-bass + duration. */
function validRomanTail(tail: string): boolean {
  if (tail === '') return true;
  const bm = ROMAN_BASS_RE.exec(tail);
  if (bm) tail = tail.slice(bm[0].length);
  if (tail === '') return true;
  return VALID_TAIL_RE.test(tail);
}

/** The case a canonical type's numeral must be written in, or null if either. */
function requiredCase(
  canonical: string,
  vocab: ChordVocabulary,
): 'lower' | 'upper' | null {
  const quality = vocab.entryByCanonical.get(canonical)?.quality ?? 'major';
  if (REQUIRES_LOWERCASE.has(quality)) return 'lower';
  if (REQUIRES_UPPERCASE.has(quality)) return 'upper';
  return null;
}

/**
 * The spelling the writer probably meant, for the case/suffix disagreement
 * error. Mirrors `chart.romanSymbol` exactly: correct the numeral's case, then
 * drop a leading `m` from a `min*` display suffix.
 */
function suggestedSpelling(
  accidental: string,
  numeral: string,
  canonical: string,
  want: 'lower' | 'upper',
): string {
  const fixed =
    want === 'lower' ? numeral.toLowerCase() : numeral.toUpperCase();
  const display = displaySuffixFor(canonical);
  const shown = canonical.startsWith('min') ? display.replace(/^m/, '') : display;
  return `${accidental}${fixed}${shown}`;
}

/**
 * Parse one Roman-numeral chord token (e.g. `I`, `ii7`, `viio7`, `bVII`,
 * `I/V`, `V7/2`, `N.C.`).
 *
 * Accepts an optional `b`/`#` prefix, a numeral whose case must match the
 * chord's triad quality, an optional quality suffix, an optional Roman slash
 * bass, and an optional duration — see the grammar at the top of this module.
 *
 * @param token - The token to parse.
 * @param vocab - Chord vocabulary to use; defaults to the bundled
 *   `chord_types.json`.
 * @returns The parsed chord, or a {@link NoChord} for `N.C.`.
 * @throws {@link ChordParseError} on failure, with messages phrased in Roman
 *   vocabulary (including a suggested spelling when the numeral's case and
 *   the quality disagree, e.g. `Im7` → `i7`).
 *
 * @example
 * parseRomanChordToken('ii7/2');
 * // → { degree: 'ii', canonical: 'min7', bassDegree: null, units: 0.5, … }
 */
export function parseRomanChordToken(
  token: string,
  vocab: ChordVocabulary = loadVocabulary(),
): ParsedRomanChord | NoChord {
  const raw = token;
  if (NO_CHORD.has(token)) return { token: raw, noChord: true, units: 1.0 };

  const m = NUMERAL_RE.exec(token);
  if (!m) {
    throw new ChordParseError(
      `'${raw}': expected a scale degree I–VII or i–vii ` +
        `(optionally with b/# and a chord quality)`,
    );
  }
  const accidental = m[1] ?? '';
  const numeral = m[2];
  const lowercase = numeral === numeral.toLowerCase();
  const rest = token.slice(m[0].length);

  // Greedily take the longest suffix that resolves AND leaves a valid tail.
  let canonical: string | null = null;
  let matched = '';
  for (let len = rest.length; len >= 0; len--) {
    const candidate = rest.slice(0, len);
    if (!validRomanTail(rest.slice(len))) continue;
    const resolved = romanSuffixToCanonical(candidate, lowercase, vocab);
    if (resolved !== null) {
      canonical = resolved;
      matched = candidate;
      break;
    }
  }
  if (canonical === null) {
    // Report the part that failed rather than the whole token: with a valid
    // tail stripped off, what is left is the quality the writer got wrong.
    let bad = rest;
    for (let len = rest.length; len >= 0; len--) {
      if (validRomanTail(rest.slice(len))) {
        bad = rest.slice(0, len);
        break;
      }
    }
    throw new ChordParseError(
      `'${raw}': unknown chord quality '${bad}' (not in chord_types vocabulary)`,
    );
  }

  // Case and suffix must agree, and a disagreement is rejected VERBOSELY —
  // the machinery that spots it already knows the spelling that was meant, so
  // the error hands it over.
  const want = requiredCase(canonical, vocab);
  if (want !== null && ((want === 'lower') !== lowercase)) {
    const suggestion = suggestedSpelling(accidental, numeral, canonical, want);
    throw new ChordParseError(
      `'${raw}': the numeral '${accidental}${numeral}' is ` +
        `${lowercase ? 'lower' : 'upper'}case, which means a ` +
        `${lowercase ? 'minor-family' : 'major-family'} triad, but the ` +
        `quality '${matched}' is ${canonical} — you may have meant ` +
        `'${suggestion}'`,
    );
  }

  let tail = rest.slice(matched.length);
  let bassDegree: string | null = null;
  const bm = ROMAN_BASS_RE.exec(tail);
  if (bm) {
    // Always uppercase: a bass is a scale degree, not a chord, so it carries
    // no triad quality — and that is the spelling `romanSymbol` emits.
    bassDegree = `${bm[1] ?? ''}${bm[2].toUpperCase()}`;
    tail = tail.slice(bm[0].length);
  }

  let units: number;
  try {
    units = parseDuration(tail);
  } catch {
    throw new ChordParseError(`'${raw}': could not parse '${tail}' as a duration`);
  }

  const degree = `${accidental}${numeral}`;
  const symbol = `${degree}${matched}${bassDegree ? `/${bassDegree}` : ''}`;
  return { token: raw, degree, canonical, bassDegree, units, symbol };
}
