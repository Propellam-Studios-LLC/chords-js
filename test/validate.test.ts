import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { validateChords } from '../src/validate.js';

/**
 * Golden regression snapshot: validateChords(text) must reproduce the committed
 * `parsed` record + errors for every `.chords` fixture in
 * test/fixtures/chords_corpus (snapshot: test/fixtures/validate_golden.json).
 * The snapshot is this library's own output under the syntactic structure
 * model (per-bar `leading_barline`, no repeat expansion). Regenerate with
 * `node scripts/regen-golden.mjs` after an intended change.
 */

const corpus = resolve(process.cwd(), 'test/fixtures/chords_corpus');
const golden = JSON.parse(
  readFileSync(resolve(process.cwd(), 'test/fixtures/validate_golden.json'), 'utf8'),
) as Record<
  string,
  { errors: string[]; warnings: string[]; parsed: Record<string, unknown> | null }
>;

const names = readdirSync(corpus)
  .filter((f) => f.endsWith('.chords') && !f.startsWith('_'))
  .map((f) => f.slice(0, -'.chords'.length))
  .sort();

describe('validateChords — golden snapshot', () => {
  for (const name of names) {
    it(`validates ${name} to the golden`, () => {
      const text = readFileSync(resolve(corpus, `${name}.chords`), 'utf8');
      const got = validateChords(text);
      const want = golden[name];

      expect(got.errors).toEqual(want.errors);
      expect(got.parsed).toEqual(want.parsed);
    });
  }
});

describe('validateChords — authored line index', () => {
  const base = ['%chords-1.0', '% id: 11111111-1111-1111-1111-111111111111'];

  it('records the body-line index per bar in parsed.form', () => {
    const r = validateChords(
      [...base, 'T: X', 'M: 4/4', 'L: 1/1', 'K: C', 'C | G |', 'Am | F |]'].join(
        '\n',
      ),
    );
    expect(r.parsed).not.toBeNull();
    expect(r.parsed!.form.bars.map((b) => b.line)).toEqual([0, 0, 1, 1]);
  });
});

describe('validateChords — error cases', () => {
  const base = ['%chords-1.0', '% id: 11111111-1111-1111-1111-111111111111'];

  it('flags a missing id stamp', () => {
    const r = validateChords(['%chords-1.0', 'M: 4/4', 'L: 1/1', 'K: C', 'C |]'].join('\n'));
    expect(r.errors.some((e) => e.includes("Missing '% id:'"))).toBe(true);
    expect(r.parsed).toBeNull();
  });

  it('skips the missing-id error when requireId is false (live authoring)', () => {
    const text = ['%chords-1.0', 'T: X', 'M: 4/4', 'L: 1/1', 'K: C', 'C |]'].join('\n');
    const r = validateChords(text, { requireId: false });
    expect(r.errors.some((e) => e.includes("Missing '% id:'"))).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.parsed).not.toBeNull();
  });

  it('still flags a malformed id even with requireId false', () => {
    const text = ['%chords-1.0', '% id: not-a-uuid', 'T: X', 'M: 4/4', 'L: 1/1', 'K: C', 'C |]'].join('\n');
    const r = validateChords(text, { requireId: false });
    expect(r.errors.some((e) => e.includes('is not a valid UUID'))).toBe(true);
  });

  it('flags missing required headers', () => {
    const r = validateChords([...base, 'T: X', 'C |]'].join('\n'));
    expect(r.errors).toContain('Missing required header M:.');
    expect(r.errors).toContain('Missing required header L:.');
    expect(r.errors).toContain('Missing required header K:.');
  });

  it('flags a bar that does not fill a measure', () => {
    const r = validateChords([...base, 'T: X', 'M: 4/4', 'L: 1/2', 'K: C', 'C |]'].join('\n'));
    // one half-measure chord in a bar that needs to sum to 1
    expect(r.errors.some((e) => e.includes('must fill exactly 1'))).toBe(true);
  });

  it('requires T: or PIECE:', () => {
    const r = validateChords([...base, 'M: 4/4', 'L: 1/1', 'K: C', 'C |]'].join('\n'));
    expect(r.errors.some((e) => e.includes('either T:'))).toBe(true);
  });

  it('warns on an unrecognized header field', () => {
    const r = validateChords(
      [...base, 'T: X', 'Zz: huh', 'M: 4/4', 'L: 1/1', 'K: C', 'C |]'].join('\n'),
    );
    expect(r.warnings.some((w) => w.includes("'Zz:'"))).toBe(true);
  });
});

/**
 * Durations must divide smoothly into the meter: every chord starts on one of
 * the bar's comping slots, so the meter's comping scaffold can always be
 * played as written.
 */
describe('smooth durations — chord onsets land on the meter\'s comping slots', () => {
  const chart = (meter: string, body: string, l = '1/1'): string =>
    [
      '%chords-1.0',
      '% id: 3f8c1d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
      'T:Probe',
      `M:${meter}`,
      `L:${l}`,
      'K:C',
      body,
    ].join('\n') + '\n';

  it('accepts a waltz bar split into thirds', () => {
    expect(validateChords(chart('3/4', '| C2/3 G/3 | C/3 F/3 G/3 |]')).errors).toEqual([]);
  });

  it('rejects a waltz bar split in half', () => {
    const { errors } = validateChords(chart('3/4', '| C/2 G/2 |]'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Bar 1: 'G/2' starts 1.50 beats into the bar");
    expect(errors[0]).toContain('not one of the 3 comping slots of 3/4');
    expect(errors[0]).toContain('multiple of 1/3 of a bar');
  });

  it('accepts halves, quarters and 3/4 in 4/4', () => {
    expect(validateChords(chart('4/4', '| C/2 G/2 | C/4 D/4 E/4 F/4 | C3/4 G/4 |]')).errors)
      .toEqual([]);
  });

  it('rejects thirds in 4/4', () => {
    const { errors } = validateChords(chart('4/4', '| C/3 F/3 G/3 |]'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not one of the 4 comping slots of 4/4');
  });

  it('measures a compound bar in dotted-quarter beats', () => {
    expect(validateChords(chart('6/8', '| C/2 G/2 |]')).errors).toEqual([]);
    const { errors } = validateChords(chart('6/8', '| C/3 F/3 G/3 |]'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not one of the 2 comping slots of 6/8');
  });

  it('accepts an odd meter grouped 2+3 and every beat of it', () => {
    // An odd meter groups as 2 + ... + 3, so 5/4 is 2+3. Fifths express both
    // that and a chord per beat; halves do not exist in a five-beat bar.
    expect(validateChords(chart('5/4', '| C2/5 G3/5 | C/5 D/5 E/5 F/5 G/5 |]')).errors)
      .toEqual([]);
    expect(validateChords(chart('5/4', '| C/2 G/2 |]')).errors).toHaveLength(1);
  });

  it('reports at most one off-grid onset per bar, and names the bar', () => {
    const { errors } = validateChords(chart('3/4', '| C |: C/2 G/2 |]'));
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith('Bar 2:')).toBe(true);
  });

  it('leaves 3/8 alone — its bar is not a whole number of beats', () => {
    expect(validateChords(chart('3/8', '| C/2 G/2 |]')).errors).toEqual([]);
  });
});
