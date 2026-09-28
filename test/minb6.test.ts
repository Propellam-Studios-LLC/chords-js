import { describe, it, expect } from 'vitest';
import {
  parseChordToken,
  isNoChord,
  ChordParseError,
  type ParsedChord,
} from '../src/parseChord.js';
import { loadVocabulary } from '../src/chordTypes.js';
import { chordTonePitchClasses, realizeFormBody, type DbForm } from '../src/realize.js';
import { chordSymbol, displaySuffixFor } from '../src/chordSymbol.js';
import { qualityFor } from '../src/chartSymbolGlyphs.js';

/**
 * The minor-flat-six chord (`minb6`): a minor triad plus a flat sixth, e.g.
 * C E♭ G A♭. iReal charts spell it `C:minb6` (Cry Me a River, bar 2); without
 * a matching type in the vocabulary, a converter has to drop the ♭6.
 */
function chord(token: string): ParsedChord {
  const c = parseChordToken(token);
  if (isNoChord(c)) throw new Error(`${token} parsed as N.C.`);
  return c;
}

describe('minb6 — the vocabulary entry', () => {
  it('is in the vocabulary with the minor-flat-six stack', () => {
    const v = loadVocabulary();
    const entry = v.entryByCanonical.get('minb6');
    expect(entry).toBeDefined();
    expect(entry!.intervalPattern).toEqual(['1', 'b3', '5', 'b6']);
  });

  it('every declared alias parses to it', () => {
    for (const token of [
      'Cmb6',
      'Cm(b6)',
      'Cminb6',
      'Cmin(b6)',
      'C-b6',
      'Cm#5',
      'Cm(#5)',
      'Cmin#5',
    ]) {
      expect(chord(token).canonical, token).toBe('minb6');
    }
  });

  it('rejects degree-then-accidental spellings (Cm5#, Cm6b)', () => {
    // `Cm5#` / `Cm6b` are informal ways to describe the chord, not a spelling
    // any quality in this vocabulary accepts — every alteration is written
    // accidental-before-degree (7b5, 7#5, maj7#11). Adding the reverse order
    // for one type would make the grammar inconsistent, so these stay errors
    // and the parse error names the offending token.
    expect(() => parseChordToken('Cm5#')).toThrow(ChordParseError);
    expect(() => parseChordToken('Cm6b')).toThrow(ChordParseError);
  });

  it('does not steal a longer alias — m6 is still min6, m7 still min7', () => {
    expect(chord('Cm6').canonical).toBe('min6');
    expect(chord('Cm7').canonical).toBe('min7');
    expect(chord('Cm').canonical).toBe('min');
  });
});

describe('minb6 — realization', () => {
  it('C sounds C E♭ G A♭, and A sounds A C E F', () => {
    // Pitch classes: C=0 Eb=3 G=7 Ab=8 ; A=9 C=0 E=4 F=5
    expect([...chordTonePitchClasses('C', 'minb6')].sort((a, b) => a - b))
      .toEqual([0, 3, 7, 8]);
    expect([...chordTonePitchClasses('A', 'minb6')].sort((a, b) => a - b))
      .toEqual([0, 4, 5, 9]);
  });

  it('SPELLS the sixth flat (A♭), never as a sharp fifth (G♯)', () => {
    // The pitch set alone cannot tell these apart, and the spelling is what
    // makes the notation and the sounding chord agree. `_A` is ABC for A-flat;
    // `^G` would be G-sharp.
    const form: DbForm = {
      max_volta: 0,
      repeat_start: 0,
      repeat_end: null,
      bars: [{ volta: null, chords: [{ root: 'C', type: 'minb6', units: 1.0 }] }],
    };
    const abc = realizeFormBody(form, { key: 'C', timeSignature: '4/4' });
    expect(abc).toContain('_A');
    expect(abc).not.toContain('^G');
  });

  it('is NOT confused with Abmaj7, which shares its pitch classes', () => {
    // {C, Eb, G, Ab} is also Ab-maj7's set. Recognition is root-relative, so
    // the two stay distinct — this pins that the two relative sets differ.
    const cm = [...chordTonePitchClasses('C', 'minb6')].sort((a, b) => a - b);
    const ab = [...chordTonePitchClasses('Ab', 'maj7')].sort((a, b) => a - b);
    expect(cm).toEqual(ab); // same absolute set...
    const rel = (root: string, type: string, rootPc: number) =>
      [...chordTonePitchClasses(root, type)]
        .map((pc) => (((pc - rootPc) % 12) + 12) % 12)
        .sort((a, b) => a - b);
    expect(rel('C', 'minb6', 0)).not.toEqual(rel('Ab', 'maj7', 8));
  });
});

describe('minb6 — how it renders', () => {
  it('classical: Cm(b6) — itself a declared alias, so it round-trips', () => {
    expect(displaySuffixFor('minb6')).toBe('m(b6)');
    expect(chordSymbol('C', 'minb6')).toBe('Cm(b6)');
    expect(chord(chordSymbol('C', 'minb6')).canonical).toBe('minb6');
  });

  it('shorthand: iReal minor glyph with the flat-six as an alteration', () => {
    const parts = qualityFor('minb6', 'shorthand');
    expect(parts.quality).toBe('-');
    expect(parts.alterations).toEqual(['♭6']);
  });

  it('a slash bass still composes', () => {
    expect(chordSymbol('C', 'minb6', 'G')).toBe('Cm(b6)/G');
  });
});
