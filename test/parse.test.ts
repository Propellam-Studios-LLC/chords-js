import { describe, it, expect } from 'vitest';
import { parse, parseStructure } from '../src/parse.js';

const DOC = [
  '%chords-1.0',
  '% id: 11111111-1111-1111-1111-111111111111',
  'T: Test Tune',
  'C: Anon',
  'M: 4/4',
  'L: 1/1',
  'K: C',
  'AK: true',
  'C | F | G7 | C |]',
].join('\n');

describe('parseStructure', () => {
  it('separates version / id / headers / body', () => {
    const s = parseStructure(DOC);
    expect(s.version).toBe('1.0');
    expect(s.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(s.headers.K).toBe('C');
    expect(s.headers.T).toBe('Test Tune');
    expect(s.bodyLines).toEqual(['C | F | G7 | C |]']);
    expect(s.errors).toEqual([]);
  });

  it('flags a missing version line', () => {
    const s = parseStructure('K: C\nC | F');
    expect(s.errors.some((e) => e.includes('version line'))).toBe(true);
  });
});

describe('parse — the full form', () => {
  it('parses headers + a degree-annotated form', () => {
    const r = parse(DOC);
    expect(r.errors).toEqual([]);
    expect(r.canonicalKey).toBe('C');
    expect(r.hasFixedKey).toBe(true);
    expect(r.meter).toBe('4/4');
    expect(r.title).toBe('Test Tune');

    expect(r.form.bars.length).toBe(4);
    const b0 = r.form.bars[0].chords[0];
    expect(b0.symbol).toBe('C');
    expect(b0.root).toBe('C');
    expect(b0.type).toBe('maj');
    expect(b0.degree).toBe('I');
    expect(b0.beat).toBe(1);
    // G7 in C is V.
    expect(r.form.bars[2].chords[0].degree).toBe('V');
    expect(r.form.bars[2].chords[0].type).toBe('dom7');
  });

  it('computes beats for two half-measure chords (L: 1/2)', () => {
    const doc = ['%chords-1.0', 'M: 4/4', 'L: 1/2', 'K: C', 'Cm7 F7 |]'].join('\n');
    const r = parse(doc);
    const bar = r.form.bars[0].chords;
    expect(bar.map((c) => c.beat)).toEqual([1, 3]); // beats 1 and 3 in 4/4
  });

  it('AK: false drops the canonical key', () => {
    const doc = ['%chords-1.0', 'K: C', 'AK: false', 'C | G7 |]'].join('\n');
    const r = parse(doc);
    expect(r.hasFixedKey).toBe(false);
    expect(r.canonicalKey).toBeNull();
    // degree is still computed from the K: for analysis.
    expect(r.form.bars[0].chords[0].degree).toBe('I');
  });

  it('keeps repeat structure in the form as per-bar leading barlines', () => {
    const doc = ['%chords-1.0', 'K: C', '|: C | F :|'].join('\n');
    const r = parse(doc);
    expect(r.form.bars.map((b) => b.leadingBarline)).toEqual(['repeatOpen', 'plain']);
    expect(r.form.finalBarline).toBe('repeatClose');
  });

  it('a no-chord bar carries no type/degree', () => {
    const doc = ['%chords-1.0', 'K: C', 'N.C. | C |]'].join('\n');
    const r = parse(doc);
    expect(r.form.bars[0].chords[0].noChord).toBe(true);
    expect(r.form.bars[0].chords[0].type).toBeNull();
  });
});
