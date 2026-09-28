import { describe, it, expect } from 'vitest';
import {
  romanBarsToAbsolute,
  absoluteBarsToRoman,
  type SimpleChord,
} from '../src/convertBars.js';

const c = (root: string, type: string, bass: string | null = null): SimpleChord => ({
  root,
  type,
  bass,
});

describe('romanBarsToAbsolute', () => {
  it('spells diatonic degrees in the key (ii-V-I in C -> Dm G C)', () => {
    const { bars, failures } = romanBarsToAbsolute(
      [[c('ii', 'min7')], [c('V', 'dom7')], [c('I', 'maj')]],
      'C',
    );
    expect(failures).toEqual([]);
    expect(bars).toEqual([
      [c('D', 'min7')],
      [c('G', 'dom7')],
      [c('C', 'maj')],
    ]);
  });

  it('spells a chromatic degree (bVII in C -> Bb)', () => {
    const { bars, failures } = romanBarsToAbsolute([[c('bVII', 'maj')]], 'C');
    expect(failures).toEqual([]);
    expect(bars[0][0].root).toBe('Bb');
  });

  it('spells a slash bass degree (I/V in G -> G/D)', () => {
    const { bars } = romanBarsToAbsolute([[c('I', 'maj', 'V')]], 'G');
    expect(bars[0][0]).toEqual(c('G', 'maj', 'D'));
  });

  it('passes the no-chord sentinel through unchanged', () => {
    const { bars } = romanBarsToAbsolute([[c('N.C.', 'N.C.')]], 'C');
    expect(bars[0][0]).toEqual(c('N.C.', 'N.C.'));
  });

  it('reports a root that is not a scale degree instead of dropping it', () => {
    const { failures } = romanBarsToAbsolute([[c('Q', 'maj')]], 'C');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ bar: 0, index: 0 });
    expect(failures[0].reason).toContain('scale degree');
  });
});

describe('absoluteBarsToRoman', () => {
  it('analyses diatonic chords as cased degrees (Dm G C in C -> ii V I)', () => {
    const { bars, failures } = absoluteBarsToRoman(
      [[c('D', 'min7')], [c('G', 'dom7')], [c('C', 'maj')]],
      'C',
    );
    expect(failures).toEqual([]);
    expect(bars).toEqual([
      [c('ii', 'min7')],
      [c('V', 'dom7')],
      [c('I', 'maj')],
    ]);
  });

  it('analyses a chromatic chord by its spelling (Bb in C -> bVII)', () => {
    const { bars } = absoluteBarsToRoman([[c('Bb', 'maj')]], 'C');
    expect(bars[0][0].root).toBe('bVII');
  });

  it('keeps a slash bass degree uppercase (G/D in G -> I/V)', () => {
    const { bars } = absoluteBarsToRoman([[c('G', 'maj', 'D')]], 'G');
    expect(bars[0][0]).toEqual(c('I', 'maj', 'V'));
  });

  it('reports a root that is not a note instead of dropping it', () => {
    const { failures } = absoluteBarsToRoman([[c('H', 'maj')]], 'C');
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toContain('not a recognized note');
  });
});

describe('round-trip', () => {
  it('roman -> absolute -> roman is identity for diatonic progressions', () => {
    const roman: SimpleChord[][] = [
      [c('I', 'maj')],
      [c('vi', 'min7')],
      [c('ii', 'min7', 'IV')],
      [c('V', 'dom7')],
    ];
    const abs = romanBarsToAbsolute(roman, 'C');
    expect(abs.failures).toEqual([]);
    const back = absoluteBarsToRoman(abs.bars, 'C');
    expect(back.failures).toEqual([]);
    expect(back.bars).toEqual(roman);
  });
});
