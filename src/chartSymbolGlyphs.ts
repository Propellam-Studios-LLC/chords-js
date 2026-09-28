/**
 * Chord-symbol typography for the chart renderer: how a chord is spelled on the
 * page, as opposed to how it is spelled in a `.chords` file.
 *
 * Two axes, deliberately independent:
 *
 * - **vocabulary** — `letters` (absolute roots) vs `roman` (scale degrees). That
 *   is {@link ChartMode} and it lives in the chart model.
 * - **notation** — `shorthand` (the iReal Pro look: `△` for major seventh, `ø`
 *   for half-diminished, `°` for diminished, `-` for minor, alterations set
 *   small and stacked) vs `classical` (the quality written out in full and
 *   superscripted). That is {@link SymbolNotation}.
 *
 * Roman always renders classically — a degree already carries quality in its
 * case, and `iiø7` reads worse than `ii m7♭5`'s classical spelling — so the
 * matrix a host actually offers is
 * {letters-shorthand, letters-classical, roman}.
 *
 * ASCII accidentals become real glyphs everywhere: `♭` (U+266D) and `♯`
 * (U+266F). Never `b`/`#`.
 */

import { displaySuffixFor } from './chordSymbol.js';

/** How each chord is labelled: absolute symbols, or Roman degrees. */
export type ChartMode = 'letters' | 'roman';

/** How a chord's quality is spelled: iReal-Pro shorthand, or written out. */
export type SymbolNotation = 'shorthand' | 'classical';

/** A chord symbol decomposed for typesetting. */
export interface SymbolParts {
  /** The root (letters) or degree (roman), with real accidental glyphs. */
  root: string;
  /** The quality, set smaller and raised beside the root (may be empty). */
  quality: string;
  /** Alterations set smaller still and stacked, e.g. `['♯11']`. */
  alterations: string[];
  /** Slash bass without the slash, or null. */
  bass: string | null;
}

const FLAT = '♭';
const SHARP = '♯';

/**
 * ASCII accidentals → real glyphs. A `b`/`#` is an accidental when it follows a
 * note letter or Roman numeral at the head of the string, or when it
 * immediately precedes a digit (`m7b5` → `m7♭5`, `7#11` → `7♯11`). The `b` in
 * `sus`, `add`, `sub` and friends is left alone, and a bare `B` root stays `B`.
 */
export function toGlyphs(s: string): string {
  return s
    // head accidental: B♭, F♯, ♭VII, iii♭ … (a note letter / numeral then b/#)
    .replace(/^([A-Ga-g]|[ivxIVX]+)([b#])/, (_m, head: string, acc: string) =>
      head + (acc === 'b' ? FLAT : SHARP))
    // leading accidental on a Roman degree: bVII → ♭VII
    .replace(/^b(?=[ivxIVX])/, FLAT)
    .replace(/^#(?=[ivxIVX])/, SHARP)
    // alteration accidentals: anything immediately before a digit
    .replace(/b(?=\d)/g, FLAT)
    .replace(/#(?=\d)/g, SHARP);
}

/**
 * iReal-Pro shorthand for a canonical chord type: `[quality, alterations]`.
 *
 * Anything not listed falls back to the classical suffix (better a readable
 * long-hand than an invented glyph) — so a new entry in `chord_types.json`
 * renders correctly the day it is added, just without shorthand.
 */
const SHORTHAND: Record<string, [string, string[]]> = {
  maj: ['', []],
  min: ['-', []],
  aug: ['+', []],
  dim: ['°', []],
  sus2: ['sus2', []],
  sus4: ['sus4', []],
  '6': ['6', []],
  min6: ['-6', []],
  // The minor-flat-six (as in Cry Me a River). Minor is '-' in iReal
  // shorthand and the b6 is an ALTERATION, so it rides the subscript run the
  // way 7b5 and 7#9 do rather than being spelled into the quality glyph.
  minb6: ['-', [`${FLAT}6`]],
  '6/9': ['6/9', []],
  dom7: ['7', []],
  maj7: ['△7', []],
  min7: ['-7', []],
  minmaj7: ['-△7', []],
  m7b5: ['ø7', []],
  dim7: ['°7', []],
  '7b5': ['7', [`${FLAT}5`]],
  aug7: ['7', [`${SHARP}5`]],
  '7sus4': ['7sus4', []],
  add9: ['add9', []],
  madd9: ['-add9', []],
  dom9: ['9', []],
  maj9: ['△9', []],
  min9: ['-9', []],
  dom11: ['11', []],
  min11: ['-11', []],
  dom13: ['13', []],
  maj13: ['△13', []],
  min13: ['-13', []],
  '7b9': ['7', [`${FLAT}9`]],
  '7#9': ['7', [`${SHARP}9`]],
  '7#11': ['7', [`${SHARP}11`]],
  '7b13': ['7', [`${FLAT}13`]],
  'maj7#11': ['△7', [`${SHARP}11`]],
  '13#11': ['13', [`${SHARP}11`]],
};

/** The quality + alterations for a canonical type in the requested notation. */
export function qualityFor(
  canonical: string,
  notation: SymbolNotation,
): { quality: string; alterations: string[] } {
  if (notation === 'shorthand') {
    const hit = SHORTHAND[canonical];
    if (hit) return { quality: hit[0], alterations: hit[1] };
  }
  return { quality: toGlyphs(displaySuffixFor(canonical)), alterations: [] };
}

/** Flat text of a symbol — what the width estimate and the plain label use. */
export function symbolText(p: SymbolParts): string {
  return (
    p.root + p.quality + p.alterations.join('') + (p.bass ? `/${p.bass}` : '')
  );
}

/** The no-chord symbol, in both notations. */
export const NO_CHORD_PARTS: SymbolParts = {
  root: 'N.C.',
  quality: '',
  alterations: [],
  bass: null,
};

/**
 * Decompose an already-spelled symbol string (e.g. `Ebmaj7/Ab`, `bVII7`) into
 * typesetting parts. Used by hosts that hold a label and no chord record; the
 * chart model itself builds parts from the chord's canonical type, which is
 * strictly better because it knows what the quality *means*.
 */
export function splitSymbol(
  symbol: string,
  mode: ChartMode = 'letters',
): SymbolParts {
  if (symbol === 'N.C.') return { ...NO_CHORD_PARTS };
  const slash = symbol.lastIndexOf('/');
  const head = slash > 0 ? symbol.slice(0, slash) : symbol;
  const bass = slash > 0 ? toGlyphs(symbol.slice(slash + 1)) : null;
  const re =
    mode === 'roman' ? /^([b#]?[IVXivx]+)(.*)$/ : /^([A-G][b#]?)(.*)$/;
  const m = re.exec(head);
  const root = toGlyphs(m ? m[1] : head);
  const quality = toGlyphs(m ? m[2] : '');
  return { root, quality, alterations: [], bass };
}
