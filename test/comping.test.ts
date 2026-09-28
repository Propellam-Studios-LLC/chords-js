import { describe, it, expect } from 'vitest';
import {
  realizeFormBody,
  compingPatterns,
  boomChick,
  blockSustained,
  blockPerBeat,
  bassOnly,
  arpeggio,
  stabs,
  type DbForm,
  type CompingPattern,
  type DbFormChord,
} from '../src/realize.js';

/**
 * Tests for the configurable comping API. The default (boomChick) is
 * golden-pinned elsewhere; here we verify the pluggable surface:
 * the default stays byte-identical, the built-ins arrange the same harmony
 * differently, and a custom pattern is honoured.
 */

const opts = { key: 'C', timeSignature: '4/4' };

// One bar of C major (whole-bar, 4 quarters) — the canonical on-grid case.
const cMajorBar: DbForm = {
  max_volta: 0,
  repeat_start: 0,
  repeat_end: null,
  bars: [{ volta: null, chords: [{ root: 'C', type: 'maj', units: 1.0 }] }],
};

// Two half-bar chords (2 quarters each) in one bar.
const twoChordBar: DbForm = {
  max_volta: 0,
  repeat_start: 0,
  repeat_end: null,
  bars: [
    {
      volta: null,
      chords: [
        { root: 'C', type: 'maj', units: 0.5 },
        { root: 'G', type: 'dom7', units: 0.5 },
      ],
    },
  ],
};

describe('default comping', () => {
  it('omitting comping is identical to passing boomChick explicitly', () => {
    const a = realizeFormBody(cMajorBar, opts);
    const b = realizeFormBody(cMajorBar, { ...opts, comping: boomChick });
    expect(a).toBe(b);
  });

  it('boomChick alternates bass and stack over four beats', () => {
    const body = realizeFormBody(cMajorBar, opts);
    // bass C, on beat 1 (low octave), then the [CEG] stack, alternating.
    expect(body).toBe('"C" C, [CEG] C, [CEG] |]');
  });
});

describe('built-in patterns arrange the same harmony differently', () => {
  it('blockSustained holds one stack for the whole bar', () => {
    const body = realizeFormBody(cMajorBar, { ...opts, comping: blockSustained });
    expect(body).toBe('"C" [CEG]4 |]');
  });

  it('blockPerBeat strikes the stack on each beat (accidental carry, no repeats)', () => {
    const body = realizeFormBody(cMajorBar, { ...opts, comping: blockPerBeat });
    expect(body).toBe('"C" [CEG] [CEG] [CEG] [CEG] |]');
  });

  it('bassOnly plays only the bass note per beat', () => {
    const body = realizeFormBody(cMajorBar, { ...opts, comping: bassOnly });
    expect(body).toBe('"C" C, C, C, C, |]');
  });

  it('arpeggio rolls bass then chord tones, cycling to fill the bar', () => {
    const body = realizeFormBody(cMajorBar, { ...opts, comping: arpeggio });
    // voices = [C, (C E G)] => C,(bass) C E G across 4 beats.
    expect(body).toBe('"C" C, C E G |]');
  });

  it('stabs plays a half-beat stack + half-beat rest per beat', () => {
    const body = realizeFormBody(cMajorBar, { ...opts, comping: stabs });
    expect(body).toBe('"C" [CEG]/2 z/2 [CEG]/2 z/2 [CEG]/2 z/2 [CEG]/2 z/2 |]');
  });

  it('compingPatterns registry exposes every built-in by name', () => {
    expect(Object.keys(compingPatterns).sort()).toEqual(
      ['arpeggio', 'bassOnly', 'blockPerBeat', 'blockSustained', 'boomChick', 'stabs'].sort(),
    );
  });
});

describe('sub-beat spans fall back to a sustained stack', () => {
  it('two half-bar chords each get a 2-beat boom-chick treatment', () => {
    const body = realizeFormBody(twoChordBar, opts);
    // each chord spans 2 quarters: bass + stack.
    expect(body).toBe('"C" C, [CEG] "G7" G, [GBdf] |]');
  });

  it('blockSustained gives each half-bar chord a length-2 stack', () => {
    const body = realizeFormBody(twoChordBar, { ...opts, comping: blockSustained });
    expect(body).toBe('"C" [CEG]2 "G7" [GBdf]2 |]');
  });
});

describe('custom comping pattern', () => {
  it('receives the spelled context and its output is used verbatim', () => {
    const seen: { beat: number; quarters: string }[] = [];
    const probe: CompingPattern = (ctx) => {
      seen.push({ beat: ctx.beat, quarters: `${ctx.quarters.num}/${ctx.quarters.den}` });
      // Just the top chord tone, held for the whole span.
      const top = ctx.tones[ctx.tones.length - 1];
      return `${ctx.renderNote(top)}${ctx.abcLength(ctx.quarters)}`;
    };
    const body = realizeFormBody(twoChordBar, { ...opts, comping: probe });
    expect(body).toBe('"C" G2 "G7" f2 |]');
    expect(seen).toEqual([
      { beat: 1, quarters: '2/1' },
      { beat: 3, quarters: '2/1' },
    ]);
  });
});

/**
 * Compound meters comp in dotted-quarter beats. Counting in whole QUARTERS
 * would put a 9/8 slip jig's strokes (three dotted-quarter beats per bar) at
 * eighth positions 1/3/5 against a pulse on 1/4/7, and a whole-bar chord (9/2
 * quarters, not a whole number) would degrade to one sustained stack with no
 * comping at all.
 *
 * Each dotted beat writes out its own long–short figure (root quarter + chord
 * eighth), so the ABC directly reflects the comping pattern.
 */
describe('compound meters comp with a long–short figure per dotted beat', () => {
  const emBar: DbForm = {
    max_volta: 0,
    repeat_start: 0,
    repeat_end: null,
    bars: [{ volta: null, chords: [{ root: 'E', type: 'min', units: 1.0 }] }],
  };

  it('a 9/8 slip-jig bar plays the long-short figure on each dotted beat', () => {
    const out = realizeFormBody(emBar, { key: 'G', timeSignature: '9/8' });
    // Each dotted quarter is root (quarter) + stack (eighth).
    expect(out).toBe('"Em" E, [EGB]/2 E, [EGB]/2 E, [EGB]/2 |]');
    // Neither one stroke per dotted beat nor a single whole-bar sustain.
    expect(out).not.toContain('E,3/2');
    expect(out).not.toContain('[EGB]9/2');
  });

  it('a 6/8 jig bar plays the long-short figure on each dotted beat', () => {
    const out = realizeFormBody(emBar, { key: 'G', timeSignature: '6/8' });
    expect(out).toBe('"Em" E, [EGB]/2 E, [EGB]/2 |]');
    // Straight quarters would fight the two dotted-quarter beats.
    expect(out).not.toContain('E, [EGB] E,');
  });

  it('a 12/8 bar takes four dotted beats, each subdivided', () => {
    const out = realizeFormBody(emBar, { key: 'G', timeSignature: '12/8' });
    expect(out).toBe('"Em" E, [EGB]/2 E, [EGB]/2 E, [EGB]/2 E, [EGB]/2 |]');
  });

  it('a two-beat chord inside a 9/8 bar subdivides both of its beats', () => {
    // The Butterfly's shape: Em over the first two beats, D over the third.
    const butterfly: DbForm = {
      max_volta: 0,
      repeat_start: 0,
      repeat_end: null,
      bars: [
        {
          volta: null,
          chords: [
            { root: 'E', type: 'min', units: 2 / 3 },
            { root: 'D', type: 'maj', units: 1 / 3 },
          ],
        },
      ],
    };
    const out = realizeFormBody(butterfly, { key: 'G', timeSignature: '9/8' });
    // Every beat leads with its OWN root, so the D beat booms on D.
    expect(out).toBe('"Em" E, [EGB]/2 E, [EGB]/2 "D" D, [DFA]/2 |]');
  });

  it('3/8 is one dotted quarter, so it takes the long-short figure too', () => {
    // beatQuartersFor still counts 3/8 in eighths (the validator depends on
    // that); the bar is nonetheless one felt dotted beat.
    const out = realizeFormBody(emBar, { key: 'G', timeSignature: '3/8' });
    expect(out).toBe('"Em" E, [EGB]/2 |]');
  });

  it('the long-short figures total each compound bar exactly', () => {
    // Frac arithmetic, not floats: the quarter + eighth per dotted beat must sum
    // to the bar, or the ABC has a short/long measure.
    const quarters = (body: string): number =>
      body
        .replace(/"[^"]*"/g, '') // chord symbols
        .replace(/\|\]?/g, '') // barlines
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .reduce((sum, token) => {
          const len = token.replace(/^(\[[^\]]*\]|[A-Ga-g][,']*)/, '');
          if (len === '') return sum + 1;
          const m = /^(\d*)(?:\/(\d*))?$/.exec(len);
          if (!m) throw new Error(`unparsed length in "${token}"`);
          const num = m[1] === '' ? 1 : parseInt(m[1], 10);
          const den = m[2] === undefined ? 1 : m[2] === '' ? 2 : parseInt(m[2], 10);
          return sum + num / den;
        }, 0);
    for (const [meter, bar] of [
      ['3/8', 1.5],
      ['6/8', 3],
      ['9/8', 4.5],
      ['12/8', 6],
    ] as Array<[string, number]>) {
      expect(quarters(realizeFormBody(emBar, { key: 'G', timeSignature: meter })), meter)
        .toBeCloseTo(bar, 10);
    }
  });

  it('every built-in pattern steps by the dotted beat in 9/8', () => {
    const patterns: Array<[string, CompingPattern]> = [
      ['blockPerBeat', blockPerBeat],
      ['bassOnly', bassOnly],
      ['arpeggio', arpeggio],
      ['stabs', stabs],
    ];
    for (const [name, comping] of patterns) {
      const out = realizeFormBody(emBar, {
        key: 'G',
        timeSignature: '9/8',
        comping,
      });
      // Three strokes per bar, each a dotted quarter (stabs: 3/4 sound + 3/4
      // rest). No pattern may fall back to the 9/2 sustain.
      expect(out, name).not.toContain('9/2');
      const expected = name === 'stabs' ? '3/4' : '3/2';
      expect(out, name).toContain(expected);
    }
    // blockSustained is meant to sustain — it is the one exception.
    const held = realizeFormBody(emBar, {
      key: 'G',
      timeSignature: '9/8',
      comping: blockSustained,
    });
    expect(held).toContain('[EGB]9/2');
  });

  it('simple meters are untouched (4/4 still alternates per quarter)', () => {
    const out = realizeFormBody(emBar, { key: 'G', timeSignature: '4/4' });
    expect(out).toContain('E, [EGB] E, [EGB]');
  });
});

/**
 * The comping SCAFFOLD belongs to the METER, not to the chords. `boomChick`
 * walks the BAR's beat grid, and a chord supplies only the notes for the slots
 * it covers. Alternating bass/stack from an index local to each chord's own
 * span would keep the boom-chuck scaffold only when every chord happened to
 * start on an even beat, and an `i % 2` rule (a 4/4 rule) would accent a 3/4
 * bar's last beat like a downbeat.
 */
describe('boomChick — the scaffold follows the bar\'s beat grid', () => {
  const bar = (chords: DbFormChord[]): DbForm => ({
    max_volta: 0,
    repeat_start: 0,
    repeat_end: null,
    bars: [{ volta: null, chords }],
  });
  const C = (units: number): DbFormChord => ({ root: 'C', type: 'maj', units });
  const G = (units: number): DbFormChord => ({ root: 'G', type: 'maj', units });
  const F = (units: number): DbFormChord => ({ root: 'F', type: 'maj', units });
  const Dm = (units: number): DbFormChord => ({ root: 'D', type: 'min', units });
  const waltz = { key: 'C', timeSignature: '3/4' };

  it('a single-chord waltz bar is oom-pah-pah, not oom-pah-oom', () => {
    expect(realizeFormBody(bar([C(1)]), waltz)).toBe('"C" C, [CEG] [CEG] |]');
  });

  it('a waltz bar split 2/3 + 1/3 keeps the scaffold and swaps the notes', () => {
    // "C - EG - GB": the beat-3 pah carries the new chord.
    expect(realizeFormBody(bar([C(2 / 3), G(1 / 3)]), waltz)).toBe(
      '"C" C, [CEG] "G" [GBd] |]',
    );
  });

  it('three chords in a waltz bar still get one oom and two pahs', () => {
    expect(realizeFormBody(bar([C(1 / 3), F(1 / 3), G(1 / 3)]), waltz)).toBe(
      '"C" C, "F" [FAc] "G" [GBd] |]',
    );
  });

  it('a chord starting off the grid leads with a short stack, then joins it', () => {
    expect(realizeFormBody(bar([C(1 / 2), G(1 / 2)]), waltz)).toBe(
      '"C" C, [CEG]/2 "G" [GBd]/2 [GBd] |]',
    );
  });

  it('four chords in a 4/4 bar vamp boom-chuck-boom-chuck', () => {
    // "C - DFA - F - GBD": root only on the boom slots.
    expect(
      realizeFormBody(bar([C(1 / 4), Dm(1 / 4), F(1 / 4), G(1 / 4)]), opts),
    ).toBe('"C" C, "Dm" [DFA] "F" F, "G" [GBd] |]');
  });

  it('a chord spanning beats 2-3 of a 4/4 bar chucks then booms', () => {
    expect(realizeFormBody(bar([C(1 / 4), Dm(1 / 2), G(1 / 4)]), opts)).toBe(
      '"C" C, "Dm" [DFA] D, "G" [GBd] |]',
    );
  });

  it('odd meters group 2 + 2 + ... + a residual 3', () => {
    // 5/4 = 2+3, booms on beats 1 and 3; 7/4 = 2+2+3, booms on 1, 3 and 5.
    expect(realizeFormBody(bar([C(1)]), { key: 'C', timeSignature: '5/4' })).toBe(
      '"C" C, [CEG] C, [CEG] [CEG] |]',
    );
    expect(realizeFormBody(bar([C(1)]), { key: 'C', timeSignature: '7/4' })).toBe(
      '"C" C, [CEG] C, [CEG] C, [CEG] [CEG] |]',
    );
  });

  it('2/2 is boom-chuck-boom-chuck like 4/4', () => {
    expect(realizeFormBody(bar([C(1)]), { key: 'C', timeSignature: '2/2' })).toBe(
      '"C" C, [CEG] C, [CEG] |]',
    );
  });

  it('a one-beat chord in a compound bar gets that beat\'s own figure', () => {
    // 6/8, two chords: each dotted beat is its own long-short figure and leads
    // with its own root.
    expect(
      realizeFormBody(bar([C(1 / 2), G(1 / 2)]), { key: 'C', timeSignature: '6/8' }),
    ).toBe('"C" C, [CEG]/2 "G" G, [GBd]/2 |]');
  });

  it('a chord entirely inside one beat still sustains as a single stack', () => {
    const eighths = bar([C(1 / 8), G(1 / 8), C(3 / 4)]);
    expect(realizeFormBody(eighths, opts)).toBe(
      '"C" C,/2 "G" [GBd]/2 "C" [CEG] C, [CEG] |]',
    );
  });
});
