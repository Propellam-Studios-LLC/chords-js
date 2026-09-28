/**
 * Roman <-> absolute conversion for a lightweight *bars of chords* shape
 * (`[[{root, type, bass}]]`, see {@link SimpleChord}), as opposed to the full
 * parsed `Form` / `DbForm`. It suits chord-entry interfaces that let a user
 * switch between absolute roots (a note like `D`/`Bb`) and Roman roots (a cased
 * scale degree like `ii`/`bVII`): switching should convert the entered chords,
 * not drop them.
 *
 * Both directions reuse the per-chord key primitives in `key.ts`
 * (`degreeStringToNote`, `noteToDegree`, `degreeForChord`) so the spelling
 * convention stays in one place. They return a per-chord *result* —
 * unconvertible chords are reported (with the offending token + reason), never
 * silently dropped — so the caller can refuse the conversion and show a precise
 * message. This is the same "unrecognized -> report" contract the text parser
 * and {@link recognizeChord} follow.
 */

import { loadVocabulary } from './chordTypes.js';
import { isNoChord, NoChord } from './parseChord.js';
import { ParsedRomanChord } from './romanToken.js';
import {
  parseKey,
  degreeStringToNote,
  noteToDegree,
  degreeForChord,
} from './key.js';

/** One chord in the input shape: root + canonical type + optional slash bass. */
export interface SimpleChord {
  root: string;
  type: string;
  bass: string | null;
}

/** A chord that couldn't be converted, located by 0-based bar + index in the bar. */
export interface ConvertFailure {
  bar: number;
  index: number;
  chord: string;
  reason: string;
}

/** The result of converting a whole progression: the converted bars + failures. */
export interface ConvertResult {
  bars: SimpleChord[][];
  failures: ConvertFailure[];
}

/** True for the `N.C.` no-chord sentinel, which is passed through unchanged. */
function isNoChordSimple(c: SimpleChord): boolean {
  return c.type === 'N.C.' || c.root === 'N.C.';
}

/** A printable token for a chord, for failure messages (`Dm7`, `bII/F#`). */
function tokenOf(c: SimpleChord): string {
  return `${c.root}${c.type === 'maj' ? '' : c.type}${c.bass != null ? `/${c.bass}` : ''}`;
}

const NOTE_RE = /^([A-G])([#b]*)$/;

/**
 * Convert each bar's Roman-degree roots (e.g. `ii`, `bVII`, slash bass `V`) to
 * absolute notes in `keyStr` (a `K:`-style key such as `G` or `Em`). Total for
 * well-formed degrees; a chord whose root or bass isn't a recognized scale
 * degree is reported in `failures` and left as-is.
 *
 * @throws {@link KeyParseError} if `keyStr` is not a valid key.
 *
 * @example
 * romanBarsToAbsolute([[{ root: 'ii', type: 'min7', bass: null }]], 'C').bars;
 * // → [[{ root: 'D', type: 'min7', bass: null }]]
 */
export function romanBarsToAbsolute(
  bars: SimpleChord[][],
  keyStr: string,
): ConvertResult {
  const key = parseKey(keyStr);
  const failures: ConvertFailure[] = [];
  const out: SimpleChord[][] = bars.map((bar, b) =>
    bar.map((c, i) => {
      if (isNoChordSimple(c)) return c;
      const root = degreeStringToNote(c.root, key);
      if (root === null) {
        failures.push({
          bar: b,
          index: i,
          chord: tokenOf(c),
          reason: `'${c.root}' is not a recognized scale degree`,
        });
        return c;
      }
      let bass: string | null = null;
      if (c.bass != null) {
        bass = degreeStringToNote(c.bass, key);
        if (bass === null) {
          failures.push({
            bar: b,
            index: i,
            chord: tokenOf(c),
            reason: `bass '${c.bass}' is not a recognized scale degree`,
          });
          return c;
        }
      }
      return { root, type: c.type, bass };
    }),
  );
  return { bars: out, failures };
}

/**
 * Convert each bar's absolute-note roots (e.g. `D`, `Bb`, slash bass `F#`) to
 * cased Roman degrees in `keyStr` — the chord's own degree is cased from its
 * triad quality (minor/diminished -> lowercase), while a slash bass degree
 * stays uppercase (a bass is a single note, with no triad quality). A chord
 * whose root or bass isn't a recognized note is reported in `failures` and
 * left as-is.
 *
 * @throws {@link KeyParseError} if `keyStr` is not a valid key.
 */
export function absoluteBarsToRoman(
  bars: SimpleChord[][],
  keyStr: string,
): ConvertResult {
  const key = parseKey(keyStr);
  const vocab = loadVocabulary();
  const failures: ConvertFailure[] = [];
  const out: SimpleChord[][] = bars.map((bar, b) =>
    bar.map((c, i) => {
      if (isNoChordSimple(c)) return c;
      const rootM = NOTE_RE.exec(c.root);
      if (!rootM) {
        failures.push({
          bar: b,
          index: i,
          chord: tokenOf(c),
          reason: `'${c.root}' is not a recognized note`,
        });
        return c;
      }
      const degUpper = noteToDegree(rootM[1], rootM[2], key);
      const degree = degreeForChord(degUpper, c.type, vocab);
      let bass: string | null = null;
      if (c.bass != null) {
        const bassM = NOTE_RE.exec(c.bass);
        if (!bassM) {
          failures.push({
            bar: b,
            index: i,
            chord: tokenOf(c),
            reason: `bass '${c.bass}' is not a recognized note`,
          });
          return c;
        }
        bass = noteToDegree(bassM[1], bassM[2], key);
      }
      return { root: degree, type: c.type, bass };
    }),
  );
  return { bars: out, failures };
}

/**
 * A parsed Roman body's bars (from {@link parseRomanBody}) → the
 * `SimpleChord[][]` shape.
 *
 * Returns exactly what {@link absoluteBarsToRoman} returns — degree-rooted
 * chords with an uppercase slash-bass degree — so a body typed in Roman is
 * interchangeable with one converted from absolutes, and
 * {@link romanBarsToAbsolute} accepts it unchanged.
 *
 * No-chord tokens become the `N.C.` sentinel (`root` and `type` both
 * `'N.C.'`).
 */
export function romanChordsToSimpleBars(
  bars: { chords: (ParsedRomanChord | NoChord)[] }[],
): SimpleChord[][] {
  return bars.map((bar) =>
    bar.chords.map((c) =>
      isNoChord(c)
        ? { root: 'N.C.', type: 'N.C.', bass: null }
        : { root: c.degree, type: c.canonical, bass: c.bassDegree },
    ),
  );
}
