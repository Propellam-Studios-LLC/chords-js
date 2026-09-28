import { describe, it, expect } from 'vitest';
import {
  degreeToNote,
  degreeStringToNote,
  noteToDegree,
  parseRomanDegree,
  parseKey,
} from '../src/key.js';
import { transposeFormToKey } from '../src/transpose.js';
import type { Form } from '../src/parse.js';

/**
 * `degreeToNote` is the inverse of `noteToDegree`, and `transposeFormToKey`
 * re-spells a whole form into a new key while preserving structure.
 */

describe('degreeToNote', () => {
  it('diatonic degrees in C major', () => {
    const c = parseKey('C');
    expect(degreeToNote(1, '', c)).toBe('C');
    expect(degreeToNote(5, '', c)).toBe('G');
    expect(degreeToNote(4, '', c)).toBe('F');
  });

  it('chromatic (accidental) degrees', () => {
    const c = parseKey('C');
    expect(degreeToNote(7, 'b', c)).toBe('Bb'); // bVII
    expect(degreeToNote(1, '#', c)).toBe('C#'); // #I
  });

  it('spells on the degree letter in minor keys', () => {
    expect(degreeToNote(3, '', parseKey('Gm'))).toBe('Bb'); // III in Gm, not A#
    expect(degreeToNote(4, '', parseKey('Em'))).toBe('A'); // iv in Em
  });

  it('is the inverse of noteToDegree', () => {
    for (const keyStr of ['C', 'G', 'Bb', 'Em', 'Gm', 'F#m']) {
      const key = parseKey(keyStr);
      for (let n = 1; n <= 7; n++) {
        for (const acc of ['', 'b', '#']) {
          const note = degreeToNote(n, acc, key);
          // noteToDegree returns a cased Roman string; re-parse to (number, acc).
          const letter = note[0];
          const noteAcc = note.slice(1);
          const roundTrip = parseRomanDegree(noteToDegree(letter, noteAcc, key));
          expect(roundTrip, `round-trip ${keyStr} deg ${acc}${n} → ${note}`).toEqual({
            number: n,
            accidental: acc,
          });
        }
      }
    }
  });
});

describe('degreeStringToNote', () => {
  it('parses cased Roman strings', () => {
    expect(degreeStringToNote('iv', parseKey('Gm'))).toBe('C'); // Autumn Leaves bar 1
    expect(degreeStringToNote('III', parseKey('Gm'))).toBe('Bb');
    expect(degreeStringToNote('bVI', parseKey('C'))).toBe('Ab');
  });

  it('returns null for a non-degree token', () => {
    expect(degreeStringToNote('N.C.', parseKey('C'))).toBeNull();
  });
});

describe('transposeFormToKey', () => {
  const form: Form = {
    repeatStart: 0,
    repeatEnd: 2,
    maxVolta: 0,
    bars: [
      {
        bar: 1,
        volta: null,
        annotations: [],
        chords: [{ root: 'C', type: 'min7', degree: 'iv', units: 1.0, beat: 1 }],
      },
      {
        bar: 2,
        volta: null,
        annotations: [],
        chords: [
          { root: 'A', type: 'm7b5', degree: 'ii', units: 0.5, beat: 1 },
          {
            root: 'D',
            type: 'dom7',
            degree: 'V',
            bassDegree: 'I',
            bass: 'G',
            units: 0.5,
            beat: 3,
          },
        ],
      },
    ],
  };

  it('transposing to the canonical key reproduces the stored roots', () => {
    const out = transposeFormToKey(form, 'Gm');
    expect(out.bars[0].chords[0].root).toBe('C');
    expect(out.bars[1].chords[0].root).toBe('A');
    expect(out.bars[1].chords[1].root).toBe('D');
    expect(out.bars[1].chords[1].bass).toBe('G');
  });

  it('transposes roots + slash bass into a new key, preserving structure', () => {
    const out = transposeFormToKey(form, 'Em');
    expect(out.repeatStart).toBe(0);
    expect(out.repeatEnd).toBe(2);
    // iv of Em = A; ii of Em = F#; V of Em = B with bass I = E.
    expect(out.bars[0].chords[0].root).toBe('A');
    expect(out.bars[0].chords[0].type).toBe('min7'); // type unchanged
    expect(out.bars[0].chords[0].units).toBe(1.0); // duration unchanged
    expect(out.bars[1].chords[0].root).toBe('F#');
    expect(out.bars[1].chords[1].root).toBe('B');
    expect(out.bars[1].chords[1].bass).toBe('E');
  });

  it('passes no_chord bars through', () => {
    const ncForm: Form = {
      repeatStart: 0,
      repeatEnd: null,
      maxVolta: 0,
      bars: [
        {
          bar: 1,
          volta: null,
          annotations: [],
          chords: [{ noChord: true, type: null, units: 1.0, beat: 1 }],
        },
      ],
    };
    const out = transposeFormToKey(ncForm, 'D');
    expect(out.bars[0].chords[0].noChord).toBe(true);
  });
});
