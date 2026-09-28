/**
 * Parses one absolute `.chords` chord token into its canonical components.
 *
 * Handles durations and the slash-collision rule: `/` + a note letter (A–G)
 * is a slash **bass**; `/` + a digit (or end of token) is a fractional
 * **duration**. Behaviour is pinned by tests against reference outputs.
 */

import { ChordVocabulary, loadVocabulary } from './chordTypes.js';

/** A parsed absolute chord. */
export interface ParsedChord {
  /** The raw token as written, incl. any duration suffix (e.g. `Am7/2`). */
  token: string;
  /** Root letter, A–G. */
  root: string;
  /** Root accidental: '', '#', or 'b'. */
  rootAcc: string;
  /** Canonical chord type, e.g. `min7`. */
  canonical: string;
  /** Slash-bass letter, or null. */
  bass: string | null;
  /** Slash-bass accidental ('', '#', 'b'), or null. */
  bassAcc: string | null;
  /** Duration in `L:` units (a bare chord = 1.0; `/2` = 0.5). */
  units: number;
  /** The chord as written, WITHOUT the duration suffix (e.g. `Cmaj7/E`). */
  symbol: string;
}

/** A no-chord token (`N.C.`). */
export interface NoChord {
  /** The raw token as written (e.g. `N.C.`). */
  token: string;
  noChord: true;
  units: number;
}

/** Thrown by the chord-token parsers (e.g. {@link parseChordToken}). */
export class ChordParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChordParseError';
  }
}

/** The no-chord tokens, shared with the Roman token parser (never duplicated). */
export const NO_CHORD = new Set(['N.C.', 'NC', 'N.C']);
const ROOT_RE = /^([A-G])([#b]?)/;
const BASS_RE = /^\/([A-G])([#b]?)/;
const DURATION_RE = /^(\d*)(?:\/(\d+))?$/;
/** A bare duration remainder — shared with the Roman token parser. */
export const VALID_TAIL_RE = /^(\/|\d+|\/\d+|\d+\/\d+)$/;

/** Parse a duration suffix into a unit count (multiples of `L:`). `''` → 1.0. */
export function parseDuration(spec: string): number {
  if (spec === '') return 1.0;
  if (spec === '/') return 0.5;
  const m = DURATION_RE.exec(spec);
  if (!m || (m[1] === '' && m[2] === undefined)) {
    throw new ChordParseError(`bad duration '${spec}'`);
  }
  const num = m[1] ? parseInt(m[1], 10) : 1;
  const den = m[2] ? parseInt(m[2], 10) : 1;
  if (den === 0) throw new ChordParseError(`bad duration '${spec}' (division by zero)`);
  if (num === 0) throw new ChordParseError(`bad duration '${spec}' (a chord can't last zero units)`);
  return num / den;
}

/** True if `tail` is a valid (possibly empty) slash-bass + duration remainder. */
export function validTail(tail: string): boolean {
  if (tail === '') return true;
  const bm = BASS_RE.exec(tail);
  if (bm) tail = tail.slice(bm[0].length);
  if (tail === '') return true;
  return VALID_TAIL_RE.test(tail);
}

/** Type guard: true if a parse result is a {@link NoChord} (`N.C.`). */
export function isNoChord<T extends object>(c: T | NoChord): c is NoChord {
  return (c as NoChord).noChord === true;
}

/**
 * Parse one chord token (e.g. `Cm7`, `F#m7b5`, `G7/B`, `Bbmaj7/D2`, `N.C.`).
 *
 * The quality is matched greedily against the vocabulary's aliases, longest
 * first.
 *
 * @param token - The token to parse.
 * @param vocab - Chord vocabulary to use; defaults to the bundled
 *   `chord_types.json`.
 * @returns The parsed chord, or a {@link NoChord} for `N.C.`.
 * @throws {@link ChordParseError} if the root, quality or duration is invalid.
 *
 * @example
 * parseChordToken('G7/B2');
 * // → { root: 'G', canonical: 'dom7', bass: 'B', units: 2, symbol: 'G7/B', … }
 */
export function parseChordToken(
  token: string,
  vocab: ChordVocabulary = loadVocabulary(),
): ParsedChord | NoChord {
  const raw = token;
  if (NO_CHORD.has(token)) return { token: raw, noChord: true, units: 1.0 };

  const m = ROOT_RE.exec(token);
  if (!m) {
    throw new ChordParseError(`'${raw}': chord must start with a root note A-G`);
  }
  const root = m[1];
  const rootAcc = m[2] ?? '';
  const rest = token.slice(m[0].length);

  // Greedily match the longest quality alias that is a prefix of `rest`. The
  // empty alias is the fallback (bare major triad), handled below.
  let canonical: string | null = null;
  let matchedAlias = '';
  for (const alias of vocab.aliasesLongestFirst) {
    if (alias === '') continue;
    if (rest.startsWith(alias) && validTail(rest.slice(alias.length))) {
      canonical = vocab.aliasToCanonical.get(alias)!;
      matchedAlias = alias;
      break;
    }
  }
  if (canonical === null) {
    if (validTail(rest)) {
      canonical = vocab.aliasToCanonical.get('')!; // bare major triad
      matchedAlias = '';
    } else {
      throw new ChordParseError(
        `'${raw}': unknown chord quality '${rest}' (not in chord_types vocabulary)`,
      );
    }
  }

  let tail = rest.slice(matchedAlias.length);
  let bass: string | null = null;
  let bassAcc: string | null = null;
  const bm = BASS_RE.exec(tail);
  if (bm) {
    bass = bm[1];
    bassAcc = bm[2] ?? '';
    tail = tail.slice(bm[0].length);
  }

  let units: number;
  try {
    units = parseDuration(tail);
  } catch {
    throw new ChordParseError(`'${raw}': could not parse '${tail}' as a duration`);
  }

  const symbol =
    root + rootAcc + matchedAlias + (bass ? '/' + bass + bassAcc : '');

  return { token: raw, root, rootAcc, canonical, bass, bassAcc, units, symbol };
}
