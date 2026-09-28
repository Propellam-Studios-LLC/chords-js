import { describe, it, expect } from 'vitest';
import { compare } from '../src/compare.js';
import { parse } from '../src/parse.js';
import type { Form } from '../src/parse.js';

/**
 * Tests for compare(a, b) — the harmonic (per-written-bar, weighted-component)
 * + light structural comparison. Each chord earns weighted credit per
 * component (root, quality, seventh, extensions, bass); the root is a gate.
 */

const formOf = (key: string, body: string): Form =>
  parse(['%chords-1.0', 'M: 4/4', 'L: 1/1', `K: ${key}`, body].join('\n')).form;

describe('compare — harmonic', () => {
  it('a progression compared to itself is identical (score 1)', () => {
    const f = formOf('C', 'Dm7 | G7 | Cmaj7 | A7 |]');
    const r = compare(f, f);
    expect(r.identical).toBe(true);
    expect(r.harmonicScore01).toBe(1);
    expect(r.correct).toBe(r.expectedTotal);
    expect(r.expectedTotal).toBe(4);
  });

  it('same Roman progression in two keys compares equal (degree mode)', () => {
    const inC = formOf('C', 'Dm7 | G7 | Cmaj7 |]'); // ii V I
    const inG = formOf('G', 'Am7 | D7 | Gmaj7 |]'); // ii V I
    const r = compare(inC, inG);
    expect(r.identical).toBe(true);
    expect(r.harmonicScore01).toBe(1);
  });

  it('byDegree:false compares absolute roots (different keys now differ)', () => {
    const inC = formOf('C', 'Dm7 | G7 | Cmaj7 |]');
    const inG = formOf('G', 'Am7 | D7 | Gmaj7 |]');
    const r = compare(inC, inG, { byDegree: false });
    expect(r.identical).toBe(false);
    expect(r.correct).toBe(0); // every root differs
  });

  it('a wrong root scores zero credit for that chord (root is a gate)', () => {
    const a = formOf('C', 'Dm7 | G7 |]');
    const b = formOf('C', 'Em7 | G7 |]'); // bar 1 root wrong
    const r = compare(a, b);
    expect(r.bars[0].marks[0].rootOk).toBe(false);
    expect(r.bars[0].marks[0].credit).toBe(0);
    expect(r.bars[1].marks[0].correct).toBe(true);
    expect(r.correct).toBe(1);
  });

  it('right root, wrong quality earns partial credit (root weight only)', () => {
    const a = formOf('C', 'Dm7 |]'); // ii = min7
    const b = formOf('C', 'Dmaj7 |]'); // same degree, major + maj7th
    const r = compare(a, b);
    const m = r.bars[0].marks[0];
    expect(m.rootOk).toBe(true);
    expect(m.qualityOk).toBe(false);
    expect(m.seventhOk).toBe(false);
    expect(m.extensionsOk).toBe(true); // both have no extensions
    expect(m.bassOk).toBe(true); // both have no slash bass
    expect(m.correct).toBe(false);
    expect(m.credit).toBeCloseTo(0.4 + 0.1 + 0.05); // root + extensions + bass
  });

  it('matching quality but differing seventh gives root+quality(+ext,bass) credit', () => {
    const a = formOf('C', 'C7 |]'); // I dom7
    const b = formOf('C', 'C |]'); // I major triad (no seventh)
    const m = compare(a, b).bars[0].marks[0];
    expect(m.qualityOk).toBe(true); // both major triad
    expect(m.seventhOk).toBe(false);
    // root + quality + extensions + bass (both lack a slash bass), no seventh.
    expect(m.credit).toBeCloseTo(0.4 + 0.3 + 0.1 + 0.05);
  });

  it('extra and missing chords dilute the score', () => {
    const a = formOf('C', 'Dm7 G7 | Cmaj7 |]'); // 3 chords
    const b = formOf('C', 'Dm7 | Cmaj7 |]'); // 2 chords (G7 missing)
    const r = compare(a, b);
    expect(r.expectedTotal).toBe(3);
    // bar 1 slot 2: expected G7, actual missing → credit 0.
    expect(r.bars[0].marks[1].b).toBeNull();
    expect(r.bars[0].marks[1].credit).toBe(0);
    expect(r.harmonicScore01).toBeLessThan(1);
    expect(r.identical).toBe(false);
  });

  it('slash bass contributes its small weight', () => {
    const a = formOf('C', 'G7/B |]');
    const b = formOf('C', 'G7 |]'); // no slash bass
    const m = compare(a, b).bars[0].marks[0];
    expect(m.bassOk).toBe(false);
    expect(m.correct).toBe(false);
    // root + quality + seventh + extensions, no bass.
    expect(m.credit).toBeCloseTo(0.4 + 0.3 + 0.15 + 0.1);
  });

  it('two N.C. bars match; N.C. vs a chord does not', () => {
    const a = formOf('C', 'N.C. | Dm7 |]');
    const b = formOf('C', 'N.C. | Dm7 |]');
    expect(compare(a, b).identical).toBe(true);
    const c = formOf('C', 'C | Dm7 |]');
    const r = compare(a, c);
    expect(r.bars[0].marks[0].correct).toBe(false);
    expect(r.bars[0].marks[0].credit).toBe(0);
  });
});

describe('compare — structural', () => {
  it('reports differing bar counts', () => {
    const a = formOf('C', 'C | F | G | C |]');
    const b = formOf('C', 'C | F |]');
    const r = compare(a, b);
    expect(r.structural.barCountA).toBe(4);
    expect(r.structural.barCountB).toBe(2);
    expect(r.identical).toBe(false);
  });

  it('flags a repeat-span difference', () => {
    const a = parse(['%chords-1.0', 'K: C', '|: C | F :| G | C |]'].join('\n')).form;
    const b = parse(['%chords-1.0', 'K: C', 'C | F | G | C |]'].join('\n')).form;
    const r = compare(a, b);
    expect(r.structural.repeatChanged).toBe(true);
    expect(r.harmonicScore01).toBe(1); // same chords
    expect(r.identical).toBe(false); // but structurally different
  });

  it('never expands repeats — `|: A :|` and `A | A` are different, not equal', () => {
    // The compare is token-by-token on the WRITTEN form: a repeat is not unrolled
    // to match its longhand. `|: A :|` is 1 written bar; `A | A` is 2.
    const repeated = parse(['%chords-1.0', 'K: C', '|: A :|'].join('\n')).form;
    const longhand = parse(['%chords-1.0', 'K: C', 'A | A |]'].join('\n')).form;
    const r = compare(repeated, longhand);
    expect(r.structural.barCountA).toBe(1); // written bars, not expanded to 2
    expect(r.structural.barCountB).toBe(2);
    expect(r.identical).toBe(false);
  });
});
