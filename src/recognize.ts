/**
 * Reverse chord recognition: a set of sounding pitch classes → a named chord,
 * spelled diatonically in a key. The inverse of {@link chordTonePitchClasses},
 * useful for labelling notes played live (e.g. from a MIDI keyboard).
 * Voicing-, octave-, and inversion-agnostic on the pitch-class set; pass
 * `recognizeSlashChords` + the lowest `bassPc` to name an inversion as a slash
 * chord.
 *
 * Recognition reports a structured per-call result — a recognized chord or a
 * failure carrying the offending pitch classes. **Policy (hard error vs. a
 * placeholder such as "?") is left to the caller**, which is why there is no
 * `strict` flag here: a live display might show "?" for a failure, while a
 * form submission would treat it as an error.
 */

import { ChordVocabulary, loadVocabulary } from './chordTypes.js';
import { MusicKey, degreeToNote } from './key.js';
import { chordSymbol } from './chordSymbol.js';
import { chordTonePitchClasses } from './realize.js';

export interface RecognizeOptions {
  /** Name an inversion as a slash chord using `bassPc` (default false). */
  recognizeSlashChords?: boolean;
  /** Lowest sounding pitch class (0–11), for slash detection. */
  bassPc?: number;
}

export interface RecognizedChord {
  ok: true;
  /** Root spelled diatonically in the key, e.g. `Bb`. */
  root: string;
  /** Canonical type, e.g. `min7`. */
  type: string;
  /** Slash bass note (spelled in key), or null. */
  bass: string | null;
  /** The display symbol, e.g. `Bbm7` or `C/E`. */
  symbol: string;
}

export interface RecognizeFailure {
  ok: false;
  reason: string;
  /** The pitch classes that couldn't be named (0–11, sorted, deduped). */
  pitchClasses: number[];
}

export type RecognizeResult = RecognizedChord | RecognizeFailure;

const LETTER_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** Pitch class (0–11) of a spelled note like `Bb`/`F#`/`C`. */
function notePc(note: string): number {
  const letter = note[0];
  let acc = 0;
  for (const ch of note.slice(1)) {
    if (ch === '#') acc++;
    else if (ch === 'b') acc--;
  }
  return (((LETTER_PC[letter] + acc) % 12) + 12) % 12;
}

// Lookup from a chord's pitch-class set *relative to its root* (sorted, comma-
// joined) → canonical type. Built once from the vocabulary; the first type to
// claim a relative set wins (vocabulary order is the priority), so e.g. a plain
// major triad beats any later synonym with the same tones.
let _byRelSet: Map<string, string> | null = null;
function relSetIndex(vocab: ChordVocabulary): Map<string, string> {
  if (_byRelSet) return _byRelSet;
  const m = new Map<string, string>();
  for (const type of vocab.entryByCanonical.keys()) {
    const rel = [...chordTonePitchClasses('C', type)]
      .sort((a, b) => a - b)
      .join(',');
    if (!m.has(rel)) m.set(rel, type);
  }
  _byRelSet = m;
  return m;
}

/** True if `pc` is a (natural) diatonic scale degree of `key`. */
function isDiatonicRoot(pc: number, key: MusicKey): boolean {
  for (let d = 1; d <= 7; d++) {
    if (notePc(degreeToNote(d, '', key)) === pc) return true;
  }
  return false;
}

/** Spell `pc` in `key`, preferring a diatonic degree, then the smallest
 * accidental (sharp before flat for a chromatic note). */
function spellPcInKey(pc: number, key: MusicKey): string {
  for (const acc of ['', '#', 'b', '##', 'bb']) {
    for (let d = 1; d <= 7; d++) {
      const note = degreeToNote(d, acc, key);
      if (notePc(note) === pc) return note;
    }
  }
  // Should be unreachable for any pc in [0,11]; fall back to a sharp spelling.
  const fallback = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return fallback[((pc % 12) + 12) % 12];
}

/**
 * Recognize the chord formed by `pitchClasses`, spelled in `key`. Returns a
 * {@link RecognizedChord} or a {@link RecognizeFailure}; never throws.
 *
 * Pitch classes may be any integers (taken mod 12); duplicates are ignored.
 *
 * Order matters for ambiguous sets: when a pitch-class set names more than one
 * chord (C6 and Am7 share their notes; augmented triads and diminished sevenths
 * are symmetric), a reading whose root is diatonic in `key` is preferred, and
 * among those the one rooted on the EARLIEST matching pitch class in
 * `pitchClasses` wins. Pass the bass first to choose the reading; `bassPc`
 * only adds a slash bass to the chosen reading, it does not change the root.
 *
 * @example
 * recognizeChord([4, 7, 11, 2], parseKey('C'));
 * // → { ok: true, root: 'E', type: 'min7', bass: null, symbol: 'Em7' }
 */
export function recognizeChord(
  pitchClasses: number[],
  key: MusicKey,
  opts: RecognizeOptions = {},
): RecognizeResult {
  const vocab = loadVocabulary();
  const pcs = [...new Set(pitchClasses.map((p) => (((p % 12) + 12) % 12)))];
  if (pcs.length === 0) {
    return { ok: false, reason: 'no notes to recognize', pitchClasses: [] };
  }
  const index = relSetIndex(vocab);
  const sorted = [...pcs].sort((a, b) => a - b);

  // Try each sounding pitch class as the root; collect every match.
  const candidates: { root: number; type: string }[] = [];
  for (const root of pcs) {
    const rel = sorted
      .map((p) => (((p - root) % 12) + 12) % 12)
      .sort((a, b) => a - b)
      .join(',');
    const type = index.get(rel);
    if (type) candidates.push({ root, type });
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `unrecognized chord (pitch classes ${sorted.join(', ')})`,
      pitchClasses: sorted,
    };
  }

  // Prefer a root that's diatonic in the key (so the spelling is in-key and the
  // enharmonic ambiguity resolves), else the first match.
  const chosen =
    candidates.find((c) => isDiatonicRoot(c.root, key)) ?? candidates[0];
  const root = spellPcInKey(chosen.root, key);

  let bass: string | null = null;
  if (opts.recognizeSlashChords && opts.bassPc != null) {
    const bpc = (((opts.bassPc % 12) + 12) % 12);
    if (bpc !== chosen.root) bass = spellPcInKey(bpc, key);
  }
  return {
    ok: true,
    root,
    type: chosen.type,
    bass,
    symbol: chordSymbol(root, chosen.type, bass),
  };
}
