/**
 * Edge cases across the parser, transposer, meter and realizer, plus checks
 * that the built package matches its metadata and loads via require().
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '../src/parse.js';
import { transposeFormToKey } from '../src/transpose.js';
import { MeterError, meterNumDen, lengthToFraction } from '../src/meter.js';
import { parseDuration, ChordParseError } from '../src/parseChord.js';
import { realizeForm, RealizeError } from '../src/realize.js';
import { chartToSvg } from '../src/chart.js';
import { VERSION } from '../src/index.js';

const doc = (body: string, key = 'C') =>
  `%chords-1.0\nT: t\nM: 4/4\nL: 1/1\nK: ${key}\n${body}\n`;
const leading = (body: string) =>
  (parse(doc(body)) as any).form.bars.map((b: any) => b.leadingBarline);

describe('a volta marker does not inherit the previous bar\'s repeat barline', () => {
  it('|1 after a |: bar opens a plain first ending', () => {
    expect(leading('|: C |1 G :|2 F |]')).toEqual(['repeatOpen', 'plain', 'repeatClose']);
  });
  it('matches the spaced | [1 spelling', () => {
    expect(leading('|: C |1 G :|2 F |]')).toEqual(leading('|: C | [1 G :| [2 F |]'));
  });
  it('|2 after a :| bar does not add a spurious repeat close', () => {
    expect(leading('|: C | D :| E |2 F |]')).toEqual(['repeatOpen', 'plain', 'repeatClose', 'plain']);
  });
  it('still keeps :|[2 and |:[1 at the same boundary as repeats', () => {
    expect(leading('|: C [1 G :|[2 F |]')[2]).toBe('repeatClose');
    expect(leading('C |:[1 G :|[2 F |]')[1]).toBe('repeatOpen');
  });
});

describe('transposeFormToKey re-spells the symbol, not just root and bass', () => {
  it('G7/B in C becomes D7/F# in G, and the stale token is dropped', () => {
    const form = (parse(doc('G7/B | C |]')) as any).form;
    const t = transposeFormToKey(form, 'G');
    const c = t.bars[0].chords[0] as any;
    expect([c.root, c.bass, c.symbol]).toEqual(['D', 'F#', 'D7/F#']);
    expect(c.token).toBeUndefined();
  });
});

describe('zero-sized meters, units and durations are errors', () => {
  it('rejects M:0/4, M:4/0, L:1/0', () => {
    expect(() => meterNumDen('0/4')).toThrow(MeterError);
    expect(() => meterNumDen('4/0')).toThrow(MeterError);
    expect(() => lengthToFraction('1/0')).toThrow(MeterError);
  });
  it('rejects a zero chord duration', () => {
    expect(() => parseDuration('0')).toThrow(ChordParseError);
    expect(() => parseDuration('0/4')).toThrow(ChordParseError);
    expect(parseDuration('2')).toBe(2);
  });
});

describe('realizeForm validates and formats its headers', () => {
  const form = { bars: [{ chords: [{ root: 'C', type: 'maj', units: 1 }] }] } as any;
  it('requires key and meter with a clear error', () => {
    expect(() => realizeForm(form, {} as any)).toThrow(RealizeError);
  });
  it('keeps each header on one line', () => {
    const abc = realizeForm(form, { key: 'C', timeSignature: '4/4', title: 'Evil\nK:D' } as any);
    expect(abc).toContain('T:Evil K:D');
    expect(abc.split('\n').filter((l) => l.startsWith('K:'))).toEqual(['K:C']);
  });
});

describe('chartToSvg validates its width option', () => {
  it('falls back to the default for nonsense widths', () => {
    const text = doc('C | G |]');
    for (const w of [0, -5, NaN]) {
      expect(chartToSvg(text, { width: w } as any).svg).not.toMatch(/NaN|viewBox="0 0 -/);
    }
  });
});

describe('packaging — version and CommonJS build', () => {
  it('VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
  it('require() of the built CommonJS entry returns the exports', () => {
    const out = execFileSync(process.execPath, ['-e',
      "const m=require('./dist/index.cjs'); console.log(typeof m.parse, Object.keys(m).length)"],
      { cwd: process.cwd(), encoding: 'utf8' });
    const [kind, n] = out.trim().split(' ');
    expect(kind).toBe('function');
    expect(Number(n)).toBeGreaterThan(50);
  });
});
