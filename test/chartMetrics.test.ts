import { describe, it, expect } from 'vitest';
import { advanceWidth, charAdvance } from '../src/chartMetrics.js';

/**
 * The advance table exists so the SVG renderer never measures text through a
 * DOM — which is what makes Node and the browser emit identical bytes, and what
 * makes the no-truncation invariant checkable at layout time.
 *
 * What is pinned here is therefore *determinism and monotonicity*, not the
 * exact numbers: the goldens pin whatever the numbers are, and they may be
 * re-tuned for typography without any of these cases changing.
 */
describe('advanceWidth', () => {
  it('is deterministic', () => {
    expect(advanceWidth('Ebmaj7/Ab', 19)).toBe(advanceWidth('Ebmaj7/Ab', 19));
  });

  it('scales linearly with font size', () => {
    expect(advanceWidth('Cm7', 20)).toBeCloseTo(advanceWidth('Cm7', 10) * 2, 10);
  });

  it('grows monotonically as text is appended', () => {
    let prev = 0;
    for (const s of ['D', 'Db', 'Dbmaj7', 'Dbmaj7#11', 'Dbmaj7#11/Ab']) {
      const w = advanceWidth(s, 19);
      expect(w).toBeGreaterThan(prev);
      prev = w;
    }
  });

  it('is zero for the empty string and positive for every character', () => {
    expect(advanceWidth('', 19)).toBe(0);
    for (const ch of 'ABCDEFGabcdefg0123456789#b/()+-.,♭♯△ø°') {
      expect(charAdvance(ch)).toBeGreaterThan(0);
    }
  });

  it('counts an astral glyph (segno/coda) once, not twice', () => {
    expect(advanceWidth('\u{1d10b}', 10)).toBe(9);
  });

  it('falls back for an unknown character rather than returning 0', () => {
    expect(charAdvance('§')).toBeGreaterThan(0);
  });
});
