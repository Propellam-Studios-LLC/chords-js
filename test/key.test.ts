import { describe, it, expect } from 'vitest';
import {
  parseKey,
  noteToDegree,
  degreeForChord,
  romanFields,
  KeyParseError,
} from '../src/key.js';
import { parseChordToken, type ParsedChord } from '../src/parseChord.js';

describe('parseKey', () => {
  it('parses major, minor, and modal keys', () => {
    expect(parseKey('C').mode).toBe('major');
    expect(parseKey('Em').mode).toBe('minor');
    expect(parseKey('Bb').tonicPc).toBe(10);
    expect(parseKey('G mixolydian').mode).toBe('mixolydian');
  });

  it('throws on an invalid key', () => {
    expect(() => parseKey('H')).toThrow(KeyParseError);
    expect(() => parseKey('C wobble')).toThrow(KeyParseError);
  });
});

describe('noteToDegree (uppercase Roman)', () => {
  const C = parseKey('C');
  it('diatonic degrees in C', () => {
    expect(noteToDegree('C', '', C)).toBe('I');
    expect(noteToDegree('G', '', C)).toBe('V');
    expect(noteToDegree('F', '', C)).toBe('IV');
  });
  it('chromatic degrees keep the diatonic numeral + accidental', () => {
    expect(noteToDegree('B', 'b', C)).toBe('bVII'); // Bb in C
    expect(noteToDegree('F', '#', C)).toBe('#IV');
  });
  it('works in a minor key', () => {
    const Em = parseKey('Em');
    // F# is the 2nd degree of E minor.
    expect(noteToDegree('F', '#', Em)).toBe('II');
  });
});

describe('degreeForChord (triad casing)', () => {
  it('lowercases for minor / diminished triads, keeping the accidental', () => {
    expect(degreeForChord('II', 'm7b5')).toBe('ii'); // half-dim → lowercase
    expect(degreeForChord('VI', 'min')).toBe('vi');
    expect(degreeForChord('bVII', 'min7')).toBe('bvii');
    expect(degreeForChord('V', 'dom7')).toBe('V'); // major-ish stays upper
  });
});

describe('romanFields', () => {
  const Em = parseKey('Em');
  function rf(token: string) {
    return romanFields(parseChordToken(token), Em);
  }

  it('F#m7b5 in Em is iiø (ii / m7b5)', () => {
    const r = rf('F#m7b5');
    expect(r.degree).toBe('ii');
    expect(r.type).toBe('m7b5');
  });

  it('carries a slash-bass degree', () => {
    const r = romanFields(parseChordToken('G/B'), parseKey('C'));
    expect(r.degree).toBe('V'); // G is V of C
    expect(r.bassDegree).toBe('VII'); // B is VII of C (bass always uppercase)
  });

  it('a no-chord yields null degree/type', () => {
    const r = romanFields(parseChordToken('N.C.'), Em);
    expect(r.degree).toBeNull();
    expect(r.type).toBeNull();
  });

  it('null key → no degree but keeps the type', () => {
    const c = parseChordToken('Cm7') as ParsedChord;
    const r = romanFields(c, null);
    expect(r.degree).toBeNull();
    expect(r.type).toBe('min7');
  });
});
