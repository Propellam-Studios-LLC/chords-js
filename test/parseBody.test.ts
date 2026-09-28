import { describe, it, expect } from 'vitest';
import { parseBody, classifyToken } from '../src/parseBody.js';
import { isNoChord, type ParsedChord } from '../src/parseChord.js';

// Symbol of the i-th chord in bar b (asserts it's a real chord).
function sym(body: ReturnType<typeof parseBody>, b: number, i = 0): string {
  const c = body.bars[b].chords[i];
  if (isNoChord(c)) throw new Error('unexpected N.C.');
  return (c as ParsedChord).symbol;
}

describe('parseBody — bars and multi-chord bars', () => {
  it('splits bars on | and keeps multiple chords per bar', () => {
    const r = parseBody('C | F G | Am');
    expect(r.bars.map((b) => b.chords.length)).toEqual([1, 2, 1]);
    expect(sym(r, 0)).toBe('C');
    expect(sym(r, 1, 0)).toBe('F');
    expect(sym(r, 1, 1)).toBe('G');
    expect(r.errors).toEqual([]);
  });

  it('parses a final barline and reports no errors', () => {
    const r = parseBody('C | F |]');
    expect(r.bars.length).toBe(2);
    expect(r.errors).toEqual([]);
  });

  it('records the authored line index per bar (P: lines do not count)', () => {
    const r = parseBody(['C | G |', 'P: B', 'Am | F | Dm |]'].join('\n'));
    // Two content lines after dropping `P: B`: line 0 has 2 bars, line 1 has 3.
    expect(r.bars.map((b) => b.line)).toEqual([0, 0, 1, 1, 1]);
  });
});

describe('parseBody — repeats (per-bar leadingBarline, no expansion)', () => {
  it('|: … :| records the barlines per bar + a repeatClose final', () => {
    const r = parseBody('|: A | B :|');
    expect(r.bars.length).toBe(2);
    expect(r.bars.map((b) => b.leadingBarline)).toEqual(['repeatOpen', 'plain']);
    expect(r.finalBarline).toBe('repeatClose'); // the trailing :|
  });

  it('a bare trailing :| makes the final barline a repeatClose', () => {
    const r = parseBody('A | B | C :|');
    expect(r.bars.map((b) => b.leadingBarline)).toEqual(['none', 'plain', 'plain']);
    expect(r.finalBarline).toBe('repeatClose');
  });

  it('records repeat markers PER BAR so multiple sections survive (AABB)', () => {
    // |: A | B :| |: C | D :|  — a single repeat span per form could keep only
    // one section. The mid boundary `:| |:` canonicalizes to `repeatBoth` (::),
    // which still means "close section 1 + open section 2", so both survive.
    const r = parseBody('|: A | B :|\n|: C | D :|');
    expect(r.bars.map((b) => b.leadingBarline)).toEqual([
      'repeatOpen', // |: A
      'plain', //      | B
      'repeatBoth', // :| |: → :: closes section 1 and opens section 2
      'plain', //      | D
    ]);
    expect(r.finalBarline).toBe('repeatClose');
  });

  it('merges :| |: at one boundary into repeatBoth (::)', () => {
    const r = parseBody('A | B :: C | D |]');
    expect(r.bars[2].leadingBarline).toBe('repeatBoth'); // :: opens bar C
    expect(r.finalBarline).toBe('final');
  });
});

describe('parseBody — voltas (carried, not expanded)', () => {
  it('tags bars with their volta ending and keeps the barlines', () => {
    // C | F |1 G | C :|2 Am | F |]
    const r = parseBody('C | F |1 G | C :|2 Am | F |]');
    expect(r.bars.map((b) => b.volta)).toEqual([null, null, 1, 1, 2, 2]);
    // The 2nd ending opens on a repeat-back (`:|2`).
    expect(r.bars[4].leadingBarline).toBe('repeatClose');
    expect(r.finalBarline).toBe('final');
  });

  it('keeps the repeat-close when the volta is bracketed (`:|[2`)', () => {
    // |: C | F |[1 G | C :|[2 Am | F |]  — the bracketed-volta style that
    // iReal-derived charts use.
    const r = parseBody('|: C | F |[1 G | C :|[2 Am | F |]');
    expect(r.bars.map((b) => b.volta)).toEqual([null, null, 1, 1, 2, 2]);
    expect(r.bars[0].leadingBarline).toBe('repeatOpen');
    // The bracketed volta must not downgrade the `:|` to a plain barline.
    expect(r.bars[4].leadingBarline).toBe('repeatClose');
    expect(r.finalBarline).toBe('final');
  });

  it('keeps a repeat-open when a volta follows it directly (`|:[1`)', () => {
    const r = parseBody('|:[1 C :|[2 F |]');
    expect(r.bars.map((b) => b.volta)).toEqual([1, 2]);
    expect(r.bars[0].leadingBarline).toBe('repeatOpen');
    expect(r.bars[1].leadingBarline).toBe('repeatClose');
  });
});

describe('parseBody — annotations & N.C.', () => {
  it('attaches a quoted annotation to the bar it precedes', () => {
    const r = parseBody('"to Coda" C | F');
    expect(r.bars[0].annotations).toEqual(['to Coda']);
    expect(r.bars[1].annotations).toEqual([]);
  });

  it('passes N.C. through as a no-chord', () => {
    const r = parseBody('N.C. | C');
    expect(isNoChord(r.bars[0].chords[0])).toBe(true);
  });

  it('collects a chord parse error without throwing', () => {
    const r = parseBody('C | Hwobble | G');
    expect(r.errors.length).toBe(1);
    // the good bars still parse
    expect(sym(r, 0)).toBe('C');
  });
});

describe('parseBody — pass-through annotations (no interpretation)', () => {
  it('passes a bare D.C. through as an annotation (not an error)', () => {
    const r = parseBody('C | F D.C. |]');
    expect(r.errors).toEqual([]);
    expect(r.bars[1].annotations).toEqual(['D.C.']);
  });

  it('lets a quoted navigation mark pass through as an annotation', () => {
    const r = parseBody('"D.S. al Fine" C | F');
    expect(r.errors).toEqual([]);
    expect(r.bars[0].annotations).toEqual(['D.S. al Fine']);
  });

  it('passes a !…! decoration through as an annotation', () => {
    const r = parseBody('!segno! C | F');
    expect(r.errors).toEqual([]);
    expect(r.bars[0].annotations).toEqual(['segno']);
  });

  it('passes bare segno (S) and coda (O) shorthands through as annotations', () => {
    const r = parseBody('C S | F O |]');
    expect(r.errors).toEqual([]);
    expect(r.bars[0].annotations).toEqual(['S']);
    expect(r.bars[1].annotations).toEqual(['O']);
  });

  it('classifies bare S and O as annotations, not chords', () => {
    expect(classifyToken('S')).toEqual({ kind: 'annotation', value: 'S' });
    expect(classifyToken('O')).toEqual({ kind: 'annotation', value: 'O' });
  });

  it('does not recognize || — it decomposes to a single |', () => {
    const r = parseBody('A || B');
    expect(r.bars.length).toBe(2); // no phantom empty measure
    expect(r.bars[1].leadingBarline).toBe('plain');
  });
});
