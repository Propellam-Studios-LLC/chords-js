import { describe, expect, it } from 'vitest';

import { annotationToAbc, isAbcNavDecoration } from '../src/annotations.js';
import { parseBody } from '../src/parseBody.js';
import { parse } from '../src/parse.js';
import { chartModel } from '../src/chart.js';
import { formToDbForm, realizeForm, realizeChords } from '../src/realize.js';

// The decorators an author writes into a `.chords` progression (S, O, !fine!,
// !D.C.alfine!) must survive conversion to the stored (DB) form and be
// rendered, not silently dropped.

describe('annotationToAbc', () => {
  it('maps the bare shorthands to real abcjs decorations', () => {
    expect(annotationToAbc('S')).toBe('!segno!');
    expect(annotationToAbc('O')).toBe('!coda!');
  });

  it('keeps a recognized decoration name as a decoration', () => {
    expect(annotationToAbc('fine')).toBe('!fine!');
    expect(annotationToAbc('segno')).toBe('!segno!');
    expect(annotationToAbc('D.C.alfine')).toBe('!D.C.alfine!');
  });

  it('normalizes the navigation-mark spellings authors actually type', () => {
    expect(annotationToAbc('D.C. al fine')).toBe('!D.C.alfine!');
    expect(annotationToAbc('DC al coda')).toBe('!D.C.alcoda!');
    expect(annotationToAbc('D.S.')).toBe('!D.S.!');
  });

  it('falls back to a text annotation for anything else', () => {
    expect(annotationToAbc('intro')).toBe('"^intro"');
    expect(annotationToAbc('say "hi"')).toBe(`"^say 'hi'"`);
    // Lowercase is not the shorthand — `s` is a chord-ish token, not a segno.
    expect(annotationToAbc('vamp')).toBe('"^vamp"');
  });

  it('reports which annotations abcjs will draw as glyphs', () => {
    expect(isAbcNavDecoration('S')).toBe(true);
    expect(isAbcNavDecoration('D.C. al fine')).toBe(true);
    expect(isAbcNavDecoration('intro')).toBe(false);
  });
});

describe('formToDbForm carries bar annotations', () => {
  it('copies the decorators the parse recognized', () => {
    const r = parse(
      ['%chords-1.0', 'M: 4/4', 'L: 1/1', 'K: G', '|: S G | A | D | C :|'].join(
        '\n',
      ),
    );
    expect(r.errors).toEqual([]);
    const db = formToDbForm(r.form);
    expect(db.bars[0].annotations).toEqual(['S']);
    expect(db.bars[1].annotations ?? []).toEqual([]);
  });

  it('omits the field entirely when a bar carries none', () => {
    const db = formToDbForm(
      parse(['%chords-1.0', 'M: 4/4', 'L: 1/1', 'K: G', 'G | C |]'].join('\n'))
        .form,
    );
    expect('annotations' in db.bars[0]).toBe(false);
  });
});

describe('realizeForm renders the decorators', () => {
  const opts = { key: 'G', timeSignature: '4/4' };

  it("emits a segno for the |: S G | A | D | C :| progression", () => {
    const db = formToDbForm(
      parse(
        [
          '%chords-1.0',
          'M: 4/4',
          'L: 1/1',
          'K: G',
          '|: S G | A | D | C :|',
        ].join('\n'),
      ).form,
    );
    const abc = realizeForm(db, opts);
    expect(abc).toContain('!segno!');
    // …inside the bar, attached to the content, never stranded before a barline.
    expect(abc).toMatch(/!segno!\s+"G"/);
  });

  it('emits !fine! and !D.C.alfine! from a stored form', () => {
    const db = formToDbForm(
      parse(
        [
          '%chords-1.0',
          'M: 4/4',
          'L: 1/1',
          'K: G',
          '|: G | A | D | C !fine! :|',
          '|: G | G | D | G !D.C.alfine! :|',
        ].join('\n'),
      ).form,
    );
    const abc = realizeForm(db, opts);
    expect(abc).toContain('!fine!');
    expect(abc).toContain('!D.C.alfine!');
    expect(abc).not.toContain('"^fine"');
  });

  it('a trailing coda is hoisted onto its own bar, not left before the barline', () => {
    const db = formToDbForm(
      parse(
        ['%chords-1.0', 'M: 4/4', 'L: 1/1', 'K: G', 'G | D O :|'].join('\n'),
      ).form,
    );
    const abc = realizeForm(db, opts);
    expect(abc).toMatch(/!coda!\s+"D"/);
    expect(abc).not.toMatch(/!coda!\s*:\|/);
  });
});

describe('realizeChords renders the decorators the same way', () => {
  it('maps S / !fine! to decorations and hoists a bar-trailing one', () => {
    const abc = realizeChords(
      [
        '%chords-1.0',
        'T: Decorated',
        'M: 4/4',
        'L: 1/1',
        'Q: 1/4=120',
        'K: G',
        '|: S G | A | D | C !fine! :|',
        '|: G | G | D | G !D.C.alfine! :|',
      ].join('\n'),
    );
    expect(abc).toContain('!segno!');
    expect(abc).toContain('!fine!');
    expect(abc).toContain('!D.C.alfine!');
    // The hoist: the fine sits on its bar's chord, not immediately before `:|`.
    expect(abc).toMatch(/!fine!\s+"C"/);
    expect(abc).not.toMatch(/!fine!\s*:\|/);
  });

  it('leaves a plain quoted annotation exactly where it was (golden shape)', () => {
    const abc = realizeChords(
      [
        '%chords-1.0',
        'T: Volta Test',
        'M: 4/4',
        'L: 1/1',
        'Q: 1/4=120',
        'K: C',
        '"intro" C | F |]',
      ].join('\n'),
    );
    expect(abc).toContain('"^intro" "C"');
  });
});

describe('the chart draws the decorators without moving the grid', () => {
  const src = (body: string) =>
    parse(['%chords-1.0', 'M: 4/4', 'L: 1/1', 'K: G', body].join('\n')).form;

  it('carries them onto the chart model', () => {
    const chart = chartModel(src('|: S G | A | D | C !fine! :|'));
    const bars = chart.lines.flatMap((l) => l.bars);
    expect(bars[0].annotations).toEqual(['S']);
    expect(bars[3].annotations).toEqual(['fine']);
  });

  it('a decorated grid has the same bar geometry as an undecorated one', () => {
    const plain = chartModel(src('|: G | A | D | C :|'));
    const decorated = chartModel(src('|: S G | A | D | C !fine! :|'));
    const geom = (c: ReturnType<typeof chartModel>) =>
      c.lines.flatMap((l) =>
        l.bars.map((b) => b.chords.map((ch) => [ch.offset, ch.weight])),
      );
    expect(geom(decorated)).toEqual(geom(plain));
  });
});

describe('parseBody accepts the decorator shapes without errors', () => {
  it("does not collect errors for segno, fine and D.C. al fine progressions", () => {
    const a = parseBody('|: S G | A | D | C :|\n|: G | G | D | G S :|');
    expect(a.errors).toEqual([]);
    const b = parseBody(
      '|: G | A | D | C !fine! :|\n|: G | G | D | G !D.C.alfine! :|',
    );
    expect(b.errors).toEqual([]);
  });
});
