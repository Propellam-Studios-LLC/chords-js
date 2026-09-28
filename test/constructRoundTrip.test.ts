import { describe, it, expect } from 'vitest';
import { parseBody, parseRomanBody } from '../src/parseBody.js';
import { isNoChord, type ParsedChord } from '../src/parseChord.js';

/**
 * Round trip between a chord structure and its `.chords` body text.
 *
 * A chord editor can bind ONE model (a list of bars of `ParsedChord`) to two
 * views, such as a chord-button grid and a `.chords` text field. The single
 * serialization step is a `chordsTextFromStructure`-style writer, whose
 * inverse is `parseBody` here. This suite drives the exact strings such a
 * serializer emits back through the parser and checks that no chord,
 * duration, repeat or line break is lost on the way.
 *
 * The strings below are golden: they are the serializer's output character
 * for character. If the serializer's output format changes, they change with
 * it.
 */

function symbols(text: string): string[][] {
  const r = parseBody(text);
  expect(r.errors).toEqual([]);
  return r.bars.map((b) =>
    b.chords.map((c) => (isNoChord(c) ? 'N.C.' : (c as ParsedChord).symbol)),
  );
}

function units(text: string): number[][] {
  const r = parseBody(text);
  return r.bars.map((b) => b.chords.map((c) => c.units));
}

describe('serialized chord structures round-trip through parseBody', () => {
  const plain: Record<string, { bars: string[][]; units: number[][] }> = {
    'C | F |]': { bars: [['C'], ['F']], units: [[1], [1]] },
    'C/2 Fm/2 | G/2 Dm/2 |]': {
      bars: [
        ['C', 'Fm'],
        ['G', 'Dm'],
      ],
      units: [
        [0.5, 0.5],
        [0.5, 0.5],
      ],
    },
    'C/4 Fm/4 G7/4 D/4 | A/4 Em/4 B7/4 C/4 |]': {
      bars: [
        ['C', 'Fm', 'G7', 'D'],
        ['A', 'Em', 'B7', 'C'],
      ],
      units: [
        [0.25, 0.25, 0.25, 0.25],
        [0.25, 0.25, 0.25, 0.25],
      ],
    },
    'C | F | G | D |]': {
      bars: [['C'], ['F'], ['G'], ['D']],
      units: [[1], [1], [1], [1]],
    },
    'C/2 Fm/2 | G/2 Dm/2 | A/2 Em/2 | B/2 Cm/2 |]': {
      bars: [
        ['C', 'Fm'],
        ['G', 'Dm'],
        ['A', 'Em'],
        ['B', 'Cm'],
      ],
      units: [
        [0.5, 0.5],
        [0.5, 0.5],
        [0.5, 0.5],
        [0.5, 0.5],
      ],
    },
  };

  for (const [text, want] of Object.entries(plain)) {
    it(`plain: ${text}`, () => {
      expect(symbols(text)).toEqual(want.bars);
      expect(units(text)).toEqual(want.units);
      expect(parseBody(text).finalBarline).toBe('final');
      expect(parseBody(text).bars.every((b) => b.volta === null)).toBe(true);
    });
  }

  const repeats = [
    '|: C | F :|',
    '|: C/2 Fm/2 | G/2 Dm/2 :|',
    '|: C/4 Fm/4 G7/4 D/4 | A/4 Em/4 B7/4 C/4 :|',
    '|: C | F | G | D :|',
    '|: C/2 Fm/2 | G/2 Dm/2 | A/2 Em/2 | B/2 Cm/2 :|',
  ];
  for (const text of repeats) {
    it(`repeat span: ${text}`, () => {
      const r = parseBody(text);
      expect(r.errors).toEqual([]);
      expect(r.bars[0].leadingBarline).toBe('repeatOpen');
      expect(r.bars.slice(1).map((b) => b.leadingBarline)).toEqual(
        r.bars.slice(1).map(() => 'plain'),
      );
      expect(r.finalBarline).toBe('repeatClose');
    });
  }

  const voltas: Record<string, number> = {
    '|: C | F |1 G :|2 D |]': 1,
    '|: C/2 Fm/2 | G/2 Dm/2 |1 A/2 Em/2 :|2 B/2 Cm/2 |]': 2,
    '|: C/4 Fm/4 G7/4 D/4 | A/4 Em/4 B7/4 C/4 |1 C/4 Fm/4 G7/4 D/4 :|2 A/4 Em/4 B7/4 C/4 |]': 4,
  };
  for (const [text, perBar] of Object.entries(voltas)) {
    it(`1st/2nd endings, ${perBar} chord(s) per bar`, () => {
      const r = parseBody(text);
      expect(r.errors).toEqual([]);
      expect(r.bars.map((b) => b.volta)).toEqual([null, null, 1, 2]);
      expect(r.bars[0].leadingBarline).toBe('repeatOpen');
      expect(r.bars[3].leadingBarline).toBe('repeatClose');
      expect(r.bars.map((b) => b.chords.length)).toEqual([
        perBar,
        perBar,
        perBar,
        perBar,
      ]);
    });
  }

  const seams: Record<string, number> = {
    '|: C | F :|\n|: G | D :|': 1,
    '|: C/2 Fm/2 | G/2 Dm/2 :|\n|: A/2 Em/2 | B/2 Cm/2 :|': 2,
    '|: C/4 Fm/4 G7/4 D/4 | A/4 Em/4 B7/4 C/4 :|\n|: C/4 Fm/4 G7/4 D/4 | A/4 Em/4 B7/4 C/4 :|': 4,
  };
  for (const [text, perBar] of Object.entries(seams)) {
    it(`section seam keeps the authored newline, ${perBar} chord(s) per bar`, () => {
      const r = parseBody(text);
      expect(r.errors).toEqual([]);
      // The `:|` + newline + `|:` seam canonicalizes to repeatBoth on bar 2 —
      // the shape the serializer writes between two repeated sections.
      expect(r.bars.map((b) => b.leadingBarline)).toEqual([
        'repeatOpen',
        'plain',
        'repeatBoth',
        'plain',
      ]);
      expect(r.finalBarline).toBe('repeatClose');
      // The author's own line break survives as the per-bar line index.
      expect(r.bars.map((b) => b.line)).toEqual([0, 0, 1, 1]);
    });
  }

  it('a slash chord keeps its bass AND its duration', () => {
    const r = parseBody('C/E | G7/B/2 C/2 |]');
    expect(r.errors).toEqual([]);
    expect(symbols('C/E | G7/B/2 C/2 |]')).toEqual([['C/E'], ['G7/B', 'C']]);
    expect(units('C/E | G7/B/2 C/2 |]')).toEqual([[1], [0.5, 0.5]]);
  });

  it('the Roman vocabulary round-trips through parseRomanBody', () => {
    const r = parseRomanBody('ii7 | V7 | I |]');
    expect(r.errors).toEqual([]);
    expect(r.bars.map((b) => b.chords.length)).toEqual([1, 1, 1]);
  });
});
