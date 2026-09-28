/**
 * Deterministic text measurement for the chart renderer.
 *
 * The SVG renderer must produce **byte-identical output in Node and in a
 * browser** (reference-output tests, server-side rendering, command-line use),
 * so it may never call `getBBox` / `measureText`. Glyph widths come from the
 * per-character advance table below and every layout decision is pure
 * arithmetic.
 *
 * The exact numbers are not load-bearing — the reference outputs pin whatever
 * they are, and they only have to be *close enough* that the no-truncation
 * invariant never under-estimates a symbol's width. They are calibrated for a
 * bold sans stack and lean slightly wide on purpose:
 * over-estimating costs a hair of white space, under-estimating would let a
 * symbol run past its cell.
 */

/**
 * Advance width, in ems, for characters the chart emits.
 *
 * Each value is the widest bold advance measured across Helvetica/Arial
 * (Nimbus Sans, Liberation Sans), Noto Sans and Ubuntu, rounded up. The music
 * symbols are also measured in DejaVu Sans, which browsers fall back to when the
 * text font lacks them. Rounding is always upward, so an estimate errs wide,
 * never tight.
 */
const ADVANCE: Record<string, number> = {
  ' ': 0.29, '.': 0.30, ',': 0.30, '/': 0.42, '(': 0.36, ')': 0.36, '-': 0.40, '+': 0.60, '#': 0.69,
  '♭': 0.47, // flat
  '♯': 0.52, // sharp
  '△': 0.91, // major-seventh triangle
  'ø': 0.69, // half-diminished
  '°': 0.50, // diminished
  '\u{1d10b}': 0.90, // segno
  '\u{1d10c}': 0.90, // coda
  'A': 0.72, 'B': 0.72, 'C': 0.72, 'D': 0.74, 'E': 0.68, 'F': 0.68, 'G': 0.78, 'H': 0.76, 'I': 0.68, 'J': 0.68, 'K': 0.72, 'L': 0.68, 'M': 0.94,
  'N': 0.81, 'O': 0.80, 'P': 0.68, 'Q': 0.80, 'R': 0.72, 'S': 0.68, 'T': 0.68, 'U': 0.76, 'V': 0.70, 'W': 0.97, 'X': 0.68, 'Y': 0.68, 'Z': 0.68,
  'a': 0.60, 'b': 0.63, 'c': 0.57, 'd': 0.63, 'e': 0.59, 'f': 0.55, 'g': 0.63, 'h': 0.66, 'i': 0.55, 'j': 0.55, 'k': 0.62, 'l': 0.55, 'm': 0.98,
  'n': 0.66, 'o': 0.62, 'p': 0.63, 'q': 0.63, 'r': 0.55, 's': 0.57, 't': 0.55, 'u': 0.66, 'v': 0.57, 'w': 0.86, 'x': 0.58, 'y': 0.57, 'z': 0.55,
};

const DIGIT = 0.60;
const FALLBACK = 0.58;

/** Advance width of one character, in ems. */
export function charAdvance(ch: string): number {
  const known = ADVANCE[ch];
  if (known !== undefined) return known;
  if (ch >= '0' && ch <= '9') return DIGIT;
  return FALLBACK;
}

/**
 * Width of [text] at [fontSizePx], summed from the advance table. Iterates by
 * code point so an astral glyph (segno/coda) counts once, not twice.
 */
export function advanceWidth(text: string, fontSizePx: number): number {
  let em = 0;
  for (const ch of text) em += charAdvance(ch);
  return em * fontSizePx;
}
