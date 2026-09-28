/**
 * Key parsing and Roman-numeral analysis: parse an ABC `K:` value, and
 * convert between absolute notes and scale degrees in a key.
 *
 * A degree NUMBER comes from the letter distance to the tonic; the b/# prefix
 * comes from comparing the note's semitone offset to the mode's expected offset
 * for that degree. Casing (lowercase for a minor/diminished triad) is applied
 * from the chord's canonical quality.
 */

import { ChordVocabulary, loadVocabulary } from './chordTypes.js';
import { NoChord, ParsedChord, isNoChord } from './parseChord.js';

const LETTER_ORDER = 'CDEFGAB';
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const LETTER_INDEX: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const ROMAN_DEGREE_RE = /^([b#]*)([ivIV]+)$/;

const MODE_INTERVALS: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};
const MODE_PREFIXES: Record<string, string> = {
  maj: 'major', ion: 'ionian', dor: 'dorian', phr: 'phrygian',
  lyd: 'lydian', mix: 'mixolydian', min: 'minor', aeo: 'aeolian', loc: 'locrian',
};
const KEY_RE = /^([A-G])([#b]?)\s*([A-Za-z]*)\s*$/;

/** Triad qualities whose Roman numeral is lowercased. */
const LOWERCASE_QUALITIES = new Set(['minor', 'diminished']);

export class KeyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyParseError';
  }
}

/** A parsed key: tonic pitch class + letter + mode name + the mode's intervals. */
export interface MusicKey {
  tonicPc: number;
  tonicLetter: string;
  mode: string;
  intervals: number[];
}

/**
 * Parse a `K:` value like `Em`, `Bb`, `G mixolydian`. A bare tonic is major,
 * `m` is minor, and a mode word is recognized by its first three letters
 * (`mix`, `dor`, …).
 *
 * @throws {@link KeyParseError} if the value is not a recognizable key.
 */
export function parseKey(value: string): MusicKey {
  const m = KEY_RE.exec(value.trim());
  if (!m) {
    throw new KeyParseError(
      `K: '${value}' is not a valid key. Expected a root note (A-G), optional ` +
        `# or b, and optional mode (e.g. 'Em', 'Bb', 'G mixolydian').`,
    );
  }
  const letter = m[1];
  const acc = m[2];
  const modeWord = m[3].toLowerCase();
  const tonicPc = (LETTER_PC[letter] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0) + 12) % 12;
  let mode: string;
  if (modeWord === '') {
    mode = 'major';
  } else if (modeWord === 'm') {
    mode = 'minor';
  } else if (modeWord.length >= 3 && MODE_PREFIXES[modeWord.slice(0, 3)]) {
    mode = MODE_PREFIXES[modeWord.slice(0, 3)];
  } else {
    throw new KeyParseError(
      `K: mode '${modeWord}' in '${value}' is not recognized.`,
    );
  }
  return { tonicPc, tonicLetter: letter, mode, intervals: MODE_INTERVALS[mode] };
}

function accidentalPrefix(diff: number): string {
  if (diff === 0) return '';
  return diff < 0 ? 'b'.repeat(-diff) : '#'.repeat(diff);
}

/**
 * The uppercase Roman degree string for a note (letter + accidental) in `key`,
 * e.g. `noteToDegree('B', 'b', parseKey('C'))` → `bVII`.
 */
export function noteToDegree(letter: string, acc: string, key: MusicKey): string {
  const accValue = (acc.match(/#/g)?.length ?? 0) - (acc.match(/b/g)?.length ?? 0);
  const degreeIdx = (((LETTER_INDEX[letter] - LETTER_INDEX[key.tonicLetter]) % 7) + 7) % 7;
  const notePc = (((LETTER_PC[letter] + accValue) % 12) + 12) % 12;
  const actual = ((notePc - key.tonicPc) % 12 + 12) % 12;
  const expected = key.intervals[degreeIdx];
  const diff = (((actual - expected + 6) % 12) + 12) % 12 - 6; // normalize to [-6, 5]
  return accidentalPrefix(diff) + ROMAN[degreeIdx];
}

/** A parsed Roman degree: number (1–7) + accidental (`''`, `'b'`, `'#'`, …). */
export interface RomanDegree {
  number: number;
  accidental: string;
}

/**
 * Parse a Roman degree token (e.g. `ii`, `bVII`, `#IV`, case-insensitive) into
 * its number + accidental, or null if it isn't one.
 */
export function parseRomanDegree(token: string): RomanDegree | null {
  const m = ROMAN_DEGREE_RE.exec(token.trim());
  if (!m) return null;
  const accidental = m[1];
  const idx = ROMAN.indexOf(m[2].toUpperCase());
  if (idx < 0) return null;
  return { number: idx + 1, accidental };
}

/**
 * A scale degree (number 1–7 + accidental like `''`, `'b'`, `'#'`, `'bb'`)
 * in `key` → its absolute note name, spelled on the degree's diatonic letter
 * (so `III` in Gm is `Bb`, never `A#`). The exact inverse of
 * {@link noteToDegree} for in-range degrees.
 */
export function degreeToNote(number: number, accidental: string, key: MusicKey): string {
  const degreeIdx = number - 1;
  const tonicLetterIdx = LETTER_INDEX[key.tonicLetter];
  const letter = LETTER_ORDER[(tonicLetterIdx + degreeIdx) % 7];
  const accValue =
    (accidental.match(/#/g)?.length ?? 0) - (accidental.match(/b/g)?.length ?? 0);
  const targetPc = (((key.tonicPc + key.intervals[degreeIdx] + accValue) % 12) + 12) % 12;
  const naturalPc = LETTER_PC[letter];
  const noteAcc = ((((targetPc - naturalPc + 6) % 12) + 12) % 12) - 6; // [-6, 5]
  return letter + accidentalPrefix2(noteAcc);
}

/**
 * A Roman degree string in either case (`iv`, `bVII`, `#VI`) → its absolute
 * note in `key`. Returns null if `degree` isn't a Roman degree.
 */
export function degreeStringToNote(degree: string, key: MusicKey): string | null {
  const parsed = parseRomanDegree(degree);
  if (!parsed) return null;
  return degreeToNote(parsed.number, parsed.accidental, key);
}

/** `#`/`b` symbol for a note accidental value (degreeToNote uses `#`, not `^`). */
function accidentalPrefix2(acc: number): string {
  if (acc === 0) return '';
  return acc > 0 ? '#'.repeat(acc) : 'b'.repeat(-acc);
}

/** Apply triad-quality casing to an uppercase Roman degree (e.g. `II` → `ii`). */
export function degreeForChord(
  degreeUpper: string,
  canonical: string,
  vocab: ChordVocabulary = loadVocabulary(),
): string {
  const quality = vocab.entryByCanonical.get(canonical)?.quality ?? 'major';
  if (LOWERCASE_QUALITIES.has(quality)) {
    // Lowercase the roman letters; keep any leading b/# accidental.
    return degreeUpper.replace(/[IV]+/g, (s) => s.toLowerCase());
  }
  return degreeUpper;
}

/** Key-aware Roman fields for a parsed chord (degree/type/bassDegree). */
export interface RomanFields {
  degree: string | null;
  type: string | null;
  bassDegree?: string;
}

/**
 * Roman-numeral analysis of one parsed chord in `key`: the cased degree of its
 * root, its canonical type, and the uppercase degree of any slash bass. With a
 * null `key` (no fixed key) only `type` is filled in; a no-chord yields nulls.
 */
export function romanFields(
  chord: ParsedChord | NoChord,
  key: MusicKey | null,
  vocab: ChordVocabulary = loadVocabulary(),
): RomanFields {
  if (isNoChord(chord)) return { degree: null, type: null };
  const c = chord;
  const out: RomanFields = { type: c.canonical, degree: null };
  if (key !== null) {
    const degUpper = noteToDegree(c.root, c.rootAcc, key);
    out.degree = degreeForChord(degUpper, c.canonical, vocab);
    if (c.bass !== null) {
      out.bassDegree = noteToDegree(c.bass, c.bassAcc ?? '', key);
    }
  }
  return out;
}
