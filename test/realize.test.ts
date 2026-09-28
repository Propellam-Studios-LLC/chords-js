import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  realizeForm,
  realizeFormBody,
  formToDbForm,
  type DbForm,
} from '../src/realize.js';
import { parse } from '../src/parse.js';

/**
 * Golden test: `realizeForm` must reproduce the reference ABC for each fixture
 * progression, so the realization can't drift.
 *
 * Fixtures carry the realizer INPUT (the stored `form` + key + meter) and the
 * reference OUTPUT (`golden_abc`). We compare per BAR (the realized chord
 * symbol + boom-chick notes), robust to the cosmetic differences the flattened
 * DB form can't carry (part labels P:A/B/C and the author's line breaks) while
 * pinning the harmonic realization exactly.
 */

interface Fixture {
  name: string;
  key: string;
  time_signature: string;
  title?: string;
  composer?: string;
  form: DbForm;
  golden_abc: string;
}

const fixturesPath = resolve(process.cwd(), 'test/fixtures/chord_realizer_fixtures.json');
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as Fixture[];

/** Split an ABC music section into trimmed, non-empty bar contents, dropping
 * header lines (`X:`, `T:`, … and `P:` part markers) and all barline tokens. */
function bars(abc: string): string[] {
  const music = abc
    .split('\n')
    .filter((l) => l.trim() !== '' && !/^[A-Za-z]+:/.test(l.trim()))
    .join(' ');
  return music
    .split(/\|\]|\|:|:\||\|\||::|\|/)
    .map((b) => b.trim())
    .filter((b) => b !== '');
}

const nBarForm = (n: number): DbForm => ({
  max_volta: 0,
  repeat_start: 0,
  repeat_end: null,
  bars: Array.from({ length: n }, () => ({
    volta: null,
    chords: [{ root: 'C', type: 'maj', units: 1.0 }],
  })),
});

describe('realizeFormBody — line wrapping', () => {
  const opts = { key: 'C', timeSignature: '4/4' };

  it('wraps the body to a new line every 4 bars', () => {
    const body = realizeFormBody(nBarForm(8), opts);
    expect(body.split('\n').length).toBe(2); // 8 bars / 4 per line
  });

  it('keeps a short progression on one line', () => {
    const body = realizeFormBody(nBarForm(4), opts);
    expect(body.includes('\n')).toBe(false);
  });

  it('honours a configurable barsPerLine', () => {
    const body = realizeFormBody(nBarForm(8), { ...opts, barsPerLine: 2 });
    expect(body.split('\n').length).toBe(4); // 8 bars / 2 per line
  });
});

describe('realizeFormBody — golden fixtures (match the reference output)', () => {
  it('has a non-empty fixture set', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fx of fixtures) {
    it(`realizes ${fx.name}`, () => {
      const body = realizeFormBody(fx.form, {
        key: fx.key,
        timeSignature: fx.time_signature,
      });
      const got = bars(body);
      const want = bars(fx.golden_abc);
      expect(got.length).toBe(want.length);
      for (let i = 0; i < want.length; i++) {
        expect(got[i], `${fx.name}: bar ${i + 1} differs`).toBe(want[i]);
      }
    });
  }
});

describe('realizeForm — full document', () => {
  it('emits a complete ABC document with headers', () => {
    const fx = fixtures.find((f) => f.name === 'blue_monk') as Fixture;
    const abc = realizeForm(fx.form, {
      key: fx.key,
      timeSignature: fx.time_signature,
      title: fx.title,
    });
    expect(abc.startsWith('X:1')).toBe(true);
    expect(abc).toContain('K:Bb');
    expect(abc).toContain('"Bb7"');
  });

  it('emits 1st/2nd-ending volta brackets with the repeat-back on the 2nd ending', () => {
    // |: A | B |1 C :|2 D |]  — common section A B, 1st ending C, 2nd ending D.
    const form: DbForm = {
      final_barline: 'final',
      bars: [
        { leading_barline: 'repeatOpen', volta: null, chords: [{ root: 'A', type: 'maj', units: 1.0 }] },
        { leading_barline: 'plain', volta: null, chords: [{ root: 'B', type: 'maj', units: 1.0 }] },
        { leading_barline: 'plain', volta: 1, chords: [{ root: 'C', type: 'maj', units: 1.0 }] },
        { leading_barline: 'repeatClose', volta: 2, chords: [{ root: 'D', type: 'maj', units: 1.0 }] },
      ],
    };
    const body = realizeFormBody(form, { key: 'C', timeSignature: '4/4' });
    expect(body.startsWith('|:')).toBe(true); // repeat opens
    expect(body).toContain('[1'); // 1st ending bracket
    expect(body).toContain('[2'); // 2nd ending bracket
    // The repeat-back `:|` rides on the start of the 2nd ending, not a fixed close.
    expect(body).toMatch(/:\|\s*\[2/);
    expect(body.trimEnd().endsWith('|]')).toBe(true); // final barline
  });

  it('opens a plain repeat with |: and closes with :| at the end', () => {
    const form: DbForm = { ...nBarForm(4), final_barline: 'repeatClose' };
    form.bars[0].leading_barline = 'repeatOpen';
    const body = realizeFormBody(form, { key: 'C', timeSignature: '4/4' });
    expect(body.startsWith('|:')).toBe(true);
    expect(body).toContain(':|');
    expect(body).not.toContain('[1');
  });

  it('realizes MULTIPLE repeated sections (AABB) via per-bar leading barlines', () => {
    // |: A | B :| |: C | D :|  — the mid `:| |:` boundary is `repeatBoth` (::).
    const bar = (r: string, lead: DbForm['bars'][number]['leading_barline']) => ({
      volta: null as number | null,
      leading_barline: lead,
      chords: [{ root: r, type: 'maj', units: 1.0 }],
    });
    const form: DbForm = {
      final_barline: 'repeatClose',
      bars: [
        bar('A', 'repeatOpen'),
        bar('B', 'plain'),
        bar('C', 'repeatBoth'), // :| |: → ::
        bar('D', 'plain'),
      ],
    };
    const body = realizeFormBody(form, { key: 'C', timeSignature: '4/4' });
    expect(body.startsWith('|:')).toBe(true); // first section opens
    // The AABB seam renders as `:|` closing one line + a new line opening with
    // `|:`, not a lone `::` — clearer in the staff. abcjs reads them
    // the same, and multiple repeated sections still play correctly.
    expect(body).toMatch(/:\|\n\|:/);
    expect(body).not.toContain('::');
    // Section 2 repeats to the end: it closes with `:|` and NO redundant `|]`.
    expect(body.trimEnd().endsWith(':|')).toBe(true);
    expect(body.trimEnd().endsWith('|]')).toBe(false);
  });
});

describe('formToDbForm — adapter from parse() output', () => {
  it('realizes the camelCase Form from parse() via the adapter', () => {
    const doc = ['%chords-1.0', 'M: 4/4', 'L: 1/1', 'K: C', 'C | F | G7 | C |]'].join(
      '\n',
    );
    const { form } = parse(doc);
    const body = realizeFormBody(formToDbForm(form), {
      key: 'C',
      timeSignature: '4/4',
    });
    expect(bars(body).length).toBe(4);
    expect(body).toContain('"C"');
    expect(body).toContain('"G7"');
  });
});
