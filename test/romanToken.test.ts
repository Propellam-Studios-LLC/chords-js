/**
 * Roman numerals as INPUT vocabulary.
 *
 * There is no external reference parser for Roman input to compare against,
 * so the reference is the library's own Roman RENDERER (`chart.romanSymbol` +
 * `convertBars.absoluteBarsToRoman`): parsing what it writes must reproduce
 * what it was given, for every chord type in the vocabulary.
 */

import { describe, expect, it } from 'vitest';
import { romanSymbol } from '../src/chart.js';
import { loadVocabulary } from '../src/chordTypes.js';
import {
  absoluteBarsToRoman,
  romanBarsToAbsolute,
  romanChordsToSimpleBars,
  SimpleChord,
} from '../src/convertBars.js';
import { degreeForChord } from '../src/key.js';
import { ChordParseError, isNoChord } from '../src/parseChord.js';
import { parseRomanBody } from '../src/parseBody.js';
import {
  ParsedRomanChord,
  parseRomanChordToken,
  romanSuffixToCanonical,
} from '../src/romanToken.js';

/** Parse and assert it is a chord, not the no-chord sentinel. */
function rc(token: string): ParsedRomanChord {
  const c = parseRomanChordToken(token);
  if (isNoChord(c)) throw new Error(`${token} parsed as N.C.`);
  return c;
}

const c = (root: string, type: string, bass: string | null = null): SimpleChord => ({
  root,
  type,
  bass,
});

describe('the round-trip property — parsing what romanSymbol renders', () => {
  it('reproduces the degree and canonical type for EVERY chord type', () => {
    const vocab = loadVocabulary();
    const failures: string[] = [];
    for (const canonical of vocab.entryByCanonical.keys()) {
      // The renderer only ever receives a degree already cased by
      // degreeForChord, so that is the pairing to pin — an uppercase numeral
      // on a minor type is not something the renderer emits.
      for (const upper of ['I', 'II', 'IV', 'V', 'bVII']) {
        const degree = degreeForChord(upper, canonical, vocab);
        const rendered = romanSymbol({
          degree,
          type: canonical,
          units: 1,
        } as never);
        try {
          const parsed = rc(rendered);
          if (parsed.degree !== degree || parsed.canonical !== canonical) {
            failures.push(
              `${degree}/${canonical} rendered '${rendered}' → ` +
                `${parsed.degree}/${parsed.canonical}`,
            );
          }
        } catch (e) {
          failures.push(
            `${degree}/${canonical} rendered '${rendered}' → threw ${e}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('the case-aware suffix resolution rule', () => {
  // The headline: romanSymbol emits `ii7` for min7 (the lowercase numeral
  // already says minor, so the leading `m` is dropped) while `7` is an alias
  // of dom7. A parser that just swaps the root regex reads `ii7` as a
  // dominant seventh — silently, with no error.
  it('ii7 is a MINOR seventh and V7 is a DOMINANT seventh', () => {
    expect(rc('ii7').canonical).toBe('min7');
    expect(rc('V7').canonical).toBe('dom7');
  });

  const table: [string, string, string][] = [
    ['I', 'I', 'maj'],
    ['i', 'i', 'min'],
    ['V7', 'V', 'dom7'],
    ['ii7', 'ii', 'min7'],
    ['iim7', 'ii', 'min7'],
    ['iimaj7', 'ii', 'minmaj7'],
    ['Imaj7', 'I', 'maj7'],
    ['viio', 'vii', 'dim'],
    ['viio7', 'vii', 'dim7'],
    ['viidim7', 'vii', 'dim7'],
    ['iim7b5', 'ii', 'm7b5'],
    ['III+', 'III', 'aug'],
    ['IIIaug', 'III', 'aug'],
    ['IV6', 'IV', '6'],
    ['ii6', 'ii', 'min6'],
    ['ii(maj7)', 'ii', 'minmaj7'],
    ['bVII', 'bVII', 'maj'],
    ['#iv', '#iv', 'min'],
    ['Isus4', 'I', 'sus4'],
    ['ii9', 'ii', 'min9'],
    ['V9', 'V', 'dom9'],
  ];
  for (const [token, degree, canonical] of table) {
    it(`${token} → ${degree} / ${canonical}`, () => {
      const parsed = rc(token);
      expect(parsed.degree).toBe(degree);
      expect(parsed.canonical).toBe(canonical);
    });
  }

  it('is exposed on its own so the rule can be reasoned about in isolation',
    () => {
      expect(romanSuffixToCanonical('7', true)).toBe('min7');
      expect(romanSuffixToCanonical('7', false)).toBe('dom7');
      expect(romanSuffixToCanonical('nonsense', false)).toBeNull();
    });
});

// Case/suffix disagreement is REJECTED, and the error suggests the spelling
// that was probably meant.
describe('case and suffix must agree', () => {
  it('Im7 is rejected, and the error suggests i7', () => {
    expect(() => parseRomanChordToken('Im7')).toThrow(ChordParseError);
    try {
      parseRomanChordToken('Im7');
    } catch (e) {
      expect(String(e)).toContain("you may have meant 'i7'");
    }
  });

  // The suggestion is spelled with the CANONICAL display suffix, not echoed
  // back verbatim — it comes from the same renderer the parser round-trips
  // with, so following it always yields a token that parses.
  it('iii+ is rejected, and the error suggests the augmented spelling', () => {
    try {
      parseRomanChordToken('iii+');
      throw new Error('should have thrown');
    } catch (e) {
      expect(String(e)).toContain("you may have meant 'IIIaug'");
      expect(() => parseRomanChordToken('IIIaug')).not.toThrow();
    }
  });

  it('a suspended chord has no third, so EITHER case is accepted', () => {
    expect(rc('Isus4').canonical).toBe('sus4');
    expect(rc('isus4').canonical).toBe('sus4');
  });
});

describe('slash bass vs duration — the / collision', () => {
  it('a numeral after the slash is a bass degree', () => {
    const parsed = rc('I/V');
    expect(parsed.bassDegree).toBe('V');
    expect(parsed.units).toBe(1);
  });

  it('a digit after the slash is a duration', () => {
    const parsed = rc('I/2');
    expect(parsed.bassDegree).toBeNull();
    expect(parsed.units).toBe(0.5);
  });

  it('an accidental on the bass degree survives', () => {
    expect(rc('i/bVI').bassDegree).toBe('bVI');
  });

  it('a bass degree is normalised to uppercase — it is a degree, not a chord',
    () => {
      expect(rc('IV/vi').bassDegree).toBe('VI');
    });

  it('bass and duration together', () => {
    const parsed = rc('V7/I2');
    expect(parsed.bassDegree).toBe('I');
    expect(parsed.units).toBe(2);
  });

  // `/X` is a slash bass, full stop. Secondary dominants have NO notation in
  // this vocabulary and cannot be flagged as an error — the token parses,
  // just not as a classically-trained musician might intend. Callers that
  // accept Roman input should tell their users so.
  it('V/V parses as V with degree-5 in the bass, NOT a secondary dominant',
    () => {
      const parsed = rc('V/V');
      expect(parsed.canonical).toBe('maj');
      expect(parsed.bassDegree).toBe('V');
    });
});

describe('rejections speak Roman', () => {
  it('VIII and H are not scale degrees', () => {
    expect(() => parseRomanChordToken('H')).toThrow(
      /expected a scale degree I–VII or i–vii/,
    );
    expect(() => parseRomanChordToken('VIII')).toThrow(ChordParseError);
  });

  it('an unknown quality names the quality, not the whole token', () => {
    expect(() => parseRomanChordToken('ii7x')).toThrow(
      /unknown chord quality '7x'/,
    );
  });

  // A false friend worth pinning: an arabic suffix is a chord TYPE and a
  // trailing number is a DURATION, exactly as in the absolute vocabulary
  // (`C64` is a C6 lasting 4 units). Figured bass is not in this vocabulary;
  // inversions are slash bass.
  it('V64 is a sixth chord lasting four units, not a second inversion', () => {
    const parsed = rc('V64');
    expect(parsed.canonical).toBe('6');
    expect(parsed.units).toBe(4);
  });
});

describe('parseRomanBody', () => {
  it('walks bars, repeats and voltas exactly as the absolute parser does', () => {
    const body = parseRomanBody('|: i | bVII | IV | V7 :|');
    expect(body.errors).toEqual([]);
    expect(body.bars).toHaveLength(4);
    expect(body.bars[0].leadingBarline).toBe('repeatOpen');
    expect(body.finalBarline).toBe('repeatClose');
    expect((body.bars[3].chords[0] as ParsedRomanChord).canonical).toBe('dom7');
  });

  it('collects bad tokens into errors rather than throwing', () => {
    const body = parseRomanBody('| I | H | V |]');
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain('expected a scale degree');
    // The failed token contributes no chord, so its bar never flushes — the
    // same shape the absolute parser produces for an unparseable token.
    expect(body.bars).toHaveLength(2);
  });

  it('carries voltas', () => {
    const body = parseRomanBody('| I |1 V :||2 I |]');
    expect(body.bars.map((b) => b.volta)).toEqual([null, 1, 2]);
  });

  it('passes N.C. through', () => {
    const body = parseRomanBody('| N.C. | I |]');
    expect(isNoChord(body.bars[0].chords[0])).toBe(true);
  });

  it('takes no key — the same degrees realize into any key', () => {
    const bars = romanChordsToSimpleBars(parseRomanBody('| i | bVII | IV | V7 |]').bars);
    expect(romanBarsToAbsolute(bars, 'C').bars.flat()).toEqual([
      c('C', 'min'),
      c('Bb', 'maj'),
      c('F', 'maj'),
      c('G', 'dom7'),
    ]);
    expect(romanBarsToAbsolute(bars, 'Eb').bars.flat()).toEqual([
      c('Eb', 'min'),
      c('Db', 'maj'),
      c('Ab', 'maj'),
      c('Bb', 'dom7'),
    ]);
  });
});

describe('bar-level round trip with the renderer', () => {
  it('absoluteBarsToRoman → render → parseRomanBody is the identity', () => {
    const absolute: SimpleChord[][] = [
      [c('C', 'maj')],
      [c('A', 'min7')],
      [c('D', 'min7'), c('G', 'dom7')],
      [c('B', 'dim7')],
      [c('C', 'maj7', 'E')],
    ];
    const roman = absoluteBarsToRoman(absolute, 'C');
    expect(roman.failures).toEqual([]);

    const rendered = roman.bars
      .map((bar) =>
        bar
          .map((ch) =>
            romanSymbol({
              degree: ch.root,
              type: ch.type,
              bassDegree: ch.bass,
              units: 1,
            } as never),
          )
          .join(' '),
      )
      .join(' | ');

    const reparsed = parseRomanBody(`| ${rendered} |]`);
    expect(reparsed.errors).toEqual([]);
    expect(romanChordsToSimpleBars(reparsed.bars)).toEqual(roman.bars);
  });
});
