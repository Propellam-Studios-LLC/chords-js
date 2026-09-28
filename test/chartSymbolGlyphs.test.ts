import { describe, it, expect } from 'vitest';
import {
  qualityFor,
  splitSymbol,
  symbolText,
  toGlyphs,
} from '../src/chartSymbolGlyphs.js';
import { displaySuffixFor } from '../src/chordSymbol.js';
import vocab from '../src/chord_types.json' with { type: 'json' };

const CANONICALS: string[] = (vocab as { chord_types: { canonical: string }[] })
  .chord_types.map((t) => t.canonical);

describe('toGlyphs — real accidentals, never ASCII', () => {
  it('converts a root accidental', () => {
    expect(toGlyphs('Bb')).toBe('B♭');
    expect(toGlyphs('F#')).toBe('F♯');
  });

  it('converts an alteration accidental (before a digit)', () => {
    expect(toGlyphs('m7b5')).toBe('m7♭5');
    expect(toGlyphs('7#11')).toBe('7♯11');
    expect(toGlyphs('7b9')).toBe('7♭9');
  });

  it('leaves a non-accidental b alone', () => {
    expect(toGlyphs('sus4')).toBe('sus4');
    expect(toGlyphs('B')).toBe('B');
    expect(toGlyphs('add9')).toBe('add9');
  });

  it('converts a leading Roman accidental', () => {
    expect(toGlyphs('bVII')).toBe('♭VII');
    expect(toGlyphs('#iv')).toBe('♯iv');
  });
});

describe('qualityFor — every canonical type renders in both notations', () => {
  it('never emits an ASCII accidental in either notation', () => {
    for (const canonical of CANONICALS) {
      for (const notation of ['shorthand', 'classical'] as const) {
        const { quality, alterations } = qualityFor(canonical, notation);
        const text = quality + alterations.join('');
        expect(text, `${canonical} / ${notation}`).not.toMatch(/\d[b#]/);
        expect(text, `${canonical} / ${notation}`).not.toMatch(/^[b#]/);
      }
    }
  });

  it('classical is exactly the display suffix, glyph-ified', () => {
    for (const canonical of CANONICALS) {
      const { quality, alterations } = qualityFor(canonical, 'classical');
      expect(quality).toBe(toGlyphs(displaySuffixFor(canonical)));
      expect(alterations).toEqual([]);
    }
  });

  it('shorthand is the iReal-Pro vocabulary', () => {
    // The triangle alone is not a major SEVENTH: the '7' is part of the
    // spelling, so maj7 is '△7', never a bare '△'.
    expect(qualityFor('maj7', 'shorthand')).toEqual({ quality: '△7', alterations: [] });
    expect(qualityFor('minmaj7', 'shorthand')).toEqual({ quality: '-△7', alterations: [] });
    expect(qualityFor('min', 'shorthand')).toEqual({ quality: '-', alterations: [] });
    expect(qualityFor('min7', 'shorthand')).toEqual({ quality: '-7', alterations: [] });
    expect(qualityFor('m7b5', 'shorthand')).toEqual({ quality: 'ø7', alterations: [] });
    expect(qualityFor('dim7', 'shorthand')).toEqual({ quality: '°7', alterations: [] });
    expect(qualityFor('aug', 'shorthand')).toEqual({ quality: '+', alterations: [] });
  });

  it('shorthand lifts alterations out to be set small and stacked', () => {
    expect(qualityFor('7#11', 'shorthand')).toEqual({ quality: '7', alterations: ['♯11'] });
    expect(qualityFor('maj7#11', 'shorthand')).toEqual({ quality: '△7', alterations: ['♯11'] });
    expect(qualityFor('7b9', 'shorthand')).toEqual({ quality: '7', alterations: ['♭9'] });
  });

  it('an unmapped canonical falls back to the classical suffix', () => {
    expect(qualityFor('min15', 'shorthand')).toEqual({ quality: 'm15', alterations: [] });
  });
});

describe('splitSymbol — decomposing an already-spelled label', () => {
  it('splits root / quality / bass in letters mode', () => {
    expect(splitSymbol('Ebmaj7/Ab')).toEqual({
      root: 'E♭',
      quality: 'maj7',
      alterations: [],
      bass: 'A♭',
    });
  });

  it('splits a Roman degree', () => {
    expect(splitSymbol('bVII7', 'roman')).toEqual({
      root: '♭VII',
      quality: '7',
      alterations: [],
      bass: null,
    });
  });

  it('passes N.C. through whole', () => {
    expect(symbolText(splitSymbol('N.C.'))).toBe('N.C.');
  });

  it('round-trips through symbolText', () => {
    expect(symbolText(splitSymbol('Gm7b5'))).toBe('Gm7♭5');
  });
});
