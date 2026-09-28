import { describe, it, expect } from 'vitest';
import {
  parseChordToken,
  isNoChord,
  ChordParseError,
  type ParsedChord,
} from '../src/parseChord.js';
import { loadVocabulary } from '../src/chordTypes.js';

// Helper: parse and assert it's a real chord (not N.C.).
function chord(token: string): ParsedChord {
  const c = parseChordToken(token);
  if (isNoChord(c)) throw new Error(`${token} parsed as N.C.`);
  return c;
}

describe('vocabulary', () => {
  it('loads the canonical chord types and aliases', () => {
    const v = loadVocabulary();
    expect(v.entryByCanonical.has('min7')).toBe(true);
    expect(v.aliasToCanonical.get('m7')).toBe('min7');
    expect(v.aliasToCanonical.get('')).toBe('maj'); // bare major triad
    // longest-first so multi-char aliases win over 'm'.
    expect(v.aliasesLongestFirst[0].length).toBeGreaterThanOrEqual(
      v.aliasesLongestFirst[v.aliasesLongestFirst.length - 1].length,
    );
  });
});

describe('parseChordToken — quality', () => {
  it('bare letter is a major triad; m is minor', () => {
    expect(chord('E').canonical).toBe('maj');
    expect(chord('Em').canonical).toBe('min');
  });

  it('matches the longest alias (maj7 over m, m7 over m)', () => {
    expect(chord('Cmaj7').canonical).toBe('maj7');
    expect(chord('Cm7').canonical).toBe('min7');
    expect(chord('F#m7b5').canonical).toBe('m7b5');
  });

  it('parses the root + accidental', () => {
    const c = chord('F#m7b5');
    expect(c.root).toBe('F');
    expect(c.rootAcc).toBe('#');
    expect(c.bass).toBeNull();
  });
});

describe('parseChordToken — slash bass vs duration (the slash-collision rule)', () => {
  it('/letter is a bass', () => {
    const c = chord('G7/B');
    expect(c.canonical).toBe('dom7');
    expect(c.bass).toBe('B');
    expect(c.bassAcc).toBe('');
    expect(c.symbol).toBe('G7/B');
    expect(c.units).toBe(1.0);
  });

  it('a bass can carry an accidental', () => {
    expect(chord('G7/Bb').bass).toBe('B');
    expect(chord('G7/Bb').bassAcc).toBe('b');
  });

  it('/digit is a duration', () => {
    expect(chord('Cm7/2').units).toBe(0.5);
    expect(chord('Cm7/2').canonical).toBe('min7');
    expect(chord('C/2').canonical).toBe('maj'); // C major for half a bar
    expect(chord('C/2').units).toBe(0.5);
  });

  it('a bass AND a duration together', () => {
    const c = chord('Cmaj7/E2');
    expect(c.canonical).toBe('maj7');
    expect(c.bass).toBe('E');
    expect(c.units).toBe(2.0);
    expect(c.symbol).toBe('Cmaj7/E'); // symbol drops the duration
  });

  it('does not let a "6/9" alias swallow a slash bass', () => {
    expect(chord('C6/9').canonical).toBe('6/9');
    expect(chord('C6/9').bass).toBeNull();
    const slash = chord('C6/G');
    expect(slash.canonical).toBe('6');
    expect(slash.bass).toBe('G');
  });
});

describe('parseChordToken — N.C. and errors', () => {
  it('recognizes no-chord tokens', () => {
    const c = parseChordToken('N.C.');
    expect(isNoChord(c)).toBe(true);
  });

  it('throws on a missing root', () => {
    expect(() => parseChordToken('H7')).toThrow(ChordParseError);
  });

  it('throws on an unknown quality', () => {
    expect(() => parseChordToken('Cwobble')).toThrow(ChordParseError);
  });
});
