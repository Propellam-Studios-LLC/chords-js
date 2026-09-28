import { describe, it, expect } from 'vitest';
import { chartModel as buildChart } from '../src/chart.js';
import type { RenderChartOptions } from '../src/chart.js';
import { parse } from '../src/parse.js';
import type { Form } from '../src/parse.js';

/**
 * Tests for the chart MODEL (`chartModel`). The SVG renderer built on top of it
 * is pinned separately in `chartSvg.test.ts`; here we pin the model shape —
 * grouping, repeat/volta markers, symbols and per-chord weights.
 *
 * These cases also cover `parseBody`'s repeat model, independently of how the
 * SVG renderer draws it.
 */

/**
 * These model cases read chord symbols, so they ask for the CLASSICAL spelling
 * (`Dm7`) rather than the default iReal-Pro shorthand (`D-7`). The shorthand
 * vocabulary is pinned in `chartSymbolGlyphs.test.ts` and drawn in
 * `chartSvg.test.ts`.
 */
function chartModel(form: Form, opts: RenderChartOptions = {}) {
  return buildChart(form, { notation: 'classical', ...opts });
}

// ii-V-I-IV in C, with the first two bars wrapped in a repeat, via parse().
function ivivForm(): Form {
  const doc = ['%chords-1.0', 'M: 4/4', 'L: 1/1', 'K: C', '|: Dm7 | G7 :| C | F |]'].join(
    '\n',
  );
  return parse(doc).form;
}

describe('chartModel — model', () => {
  it('groups bars into lines and carries symbols + repeat markers', () => {
    const chart = chartModel(ivivForm());
    expect(chart.mode).toBe('letters');
    expect(chart.lines).toHaveLength(1); // 4 bars, 4 per line
    const bars = chart.lines[0].bars;
    expect(bars.map((b) => b.symbols)).toEqual([['Dm7'], ['G7'], ['C'], ['F']]);
    expect(bars[0].openRepeat).toBe(true); // |: on bar 1
    expect(bars[1].closeRepeat).toBe(true); // :| after bar 2
    expect(bars[2].openRepeat).toBe(false);
  });

  it('renders MULTIPLE repeated sections (AABB), not just the last one', () => {
    // Two independently-repeated 2-bar sections. A single-span repeat model
    // would keep only the last `|: … :|`; the per-bar markers must flag both.
    const doc = [
      '%chords-1.0',
      'M: 4/4',
      'L: 1/1',
      'K: C',
      '|: A | D :|',
      '|: G | E :|]',
    ].join('\n');
    const chart = chartModel(parse(doc).form, { barsPerLine: 4 });
    const bars = chart.lines.flatMap((l) => l.bars);
    expect(bars.map((b) => b.symbols)).toEqual([['A'], ['D'], ['G'], ['E']]);
    // First section |: A | D :|
    expect(bars[0].openRepeat).toBe(true);
    expect(bars[1].closeRepeat).toBe(true);
    // Second section |: G | E :| — the one a single-span model would lose.
    expect(bars[2].openRepeat).toBe(true);
    expect(bars[3].closeRepeat).toBe(true);
  });

  it('wraps to multiple lines at barsPerLine', () => {
    const chart = chartModel(ivivForm(), { barsPerLine: 2, groupByLine: false });
    expect(chart.lines).toHaveLength(2);
    expect(chart.lines[0].bars.map((b) => b.symbols)).toEqual([['Dm7'], ['G7']]);
    expect(chart.lines[1].bars.map((b) => b.symbols)).toEqual([['C'], ['F']]);
  });

  it('groupByLine wraps on the authored line breaks, not barsPerLine', () => {
    // Three authored lines with 1 / 2 / 1 bars — an uneven split barsPerLine
    // can't reproduce. The repeat spans the authored line break (Em on line 0,
    // :| closing on line 1) and the per-bar repeat flags must stay correct.
    const doc = [
      '%chords-1.0',
      'M: 4/4',
      'L: 1/1',
      'K: C',
      '|: Em |',
      'A7 | D7 :|',
      'G |]',
    ].join('\n');
    const form = parse(doc).form;
    const chart = chartModel(form, { groupByLine: true });
    expect(chart.lines.map((l) => l.bars.map((b) => b.symbols))).toEqual([
      [['Em']],
      [['A7'], ['D7']],
      [['G']],
    ]);
    // Repeat flags survive the regrouping: |: opens bar 1 (line 0), :| closes
    // bar 3 (the second bar of line 1).
    expect(chart.lines[0].bars[0].openRepeat).toBe(true);
    expect(chart.lines[1].bars[1].closeRepeat).toBe(true);
  });

  it('groupByLine falls back to barsPerLine when a bar lacks a line index', () => {
    const form = ivivForm();
    form.bars[2].line = undefined; // simulate a hand-built / pre-line form
    const chart = chartModel(form, { groupByLine: true, barsPerLine: 2 });
    expect(chart.lines).toHaveLength(2); // uniform fallback
  });

  it('spends WIDTH on sub-measure durations, never a /N suffix', () => {
    const doc = [
      '%chords-1.0',
      'M: 4/4',
      'L: 1/1',
      'K: Am',
      'Am/2 G/2 | Am',
    ].join('\n');
    const form = parse(doc).form;
    const letters = chartModel(form);
    // No `/2` reaches a label — duration is the chord's SHARE of the bar.
    expect(letters.lines[0].bars.map((b) => b.symbols)).toEqual([
      ['Am', 'G'],
      ['Am'],
    ]);
    const half = letters.lines[0].bars[0].chords;
    expect(half.map((c) => c.weight)).toEqual([0.5, 0.5]);
    expect(half.map((c) => c.offset)).toEqual([0, 0.5]);
    const roman = chartModel(form, { mode: 'roman' });
    expect(roman.lines[0].bars[0].symbols).toEqual(['i', 'VII']);
  });

  it('fractional splits carry their real shares (lotus_blossom 2/3 + 1/3)', () => {
    const doc = [
      '%chords-1.0',
      'M: 3/4',
      'L: 1/1',
      'K: Bb',
      'Em7b52/3 Ebm7b5/3 |]',
    ].join('\n');
    const chart = chartModel(parse(doc).form);
    const chords = chart.lines[0].bars[0].chords;
    expect(chords.map((c) => Math.round(c.weight * 1000) / 1000)).toEqual([
      0.667, 0.333,
    ]);
    expect(Math.round(chords[1].offset * 1000) / 1000).toBe(0.667);
  });

  it('spellHeldBars writes the governing chord into empty bars', () => {
    // The `.chords` tokenizer never emits an empty bar, but a stored form can
    // carry one (a chord held across a bar line) — that is the case this is for.
    const form = parse(
      ['%chords-1.0', 'M: 4/4', 'L: 1/1', 'K: C', 'C | G |]'].join('\n'),
    ).form;
    form.bars.splice(1, 0, { bar: 2, volta: null, annotations: [], chords: [], line: 0 });
    const chart = chartModel(form, { spellHeldBars: true });
    expect(chart.lines.flatMap((l) => l.bars).map((b) => b.symbols)).toEqual([
      ['C'],
      ['C'],
      ['G'],
    ]);
  });

  it('roman mode labels degrees and drops the redundant leading m', () => {
    const chart = chartModel(ivivForm(), { mode: 'roman' });
    // Dm7 = ii7 (m dropped), G7 = V7, C = I, F = IV.
    expect(chart.lines[0].bars.map((b) => b.symbols)).toEqual([
      ['ii7'],
      ['V7'],
      ['I'],
      ['IV'],
    ]);
  });

  it('letters mode transposes roots; roman mode is unaffected', () => {
    const letters = chartModel(ivivForm(), { transposeKey: 'G' });
    // Up a fifth: ii→Am7, V→D7, I→G, IV→C.
    expect(letters.lines[0].bars.map((b) => b.symbols)).toEqual([
      ['Am7'],
      ['D7'],
      ['G'],
      ['C'],
    ]);
    const roman = chartModel(ivivForm(), { mode: 'roman', transposeKey: 'G' });
    expect(roman.lines[0].bars[0].symbols).toEqual(['ii7']);
  });

  it('renders N.C. and multi-chord bars', () => {
    const form = parse(
      ['%chords-1.0', 'M: 4/4', 'L: 1/2', 'K: C', 'N.C. | Dm7 G7 |]'].join('\n'),
    ).form;
    const chart = chartModel(form);
    expect(chart.lines[0].bars[0].symbols).toEqual(['N.C.']);
    expect(chart.lines[0].bars[1].symbols).toEqual(['Dm7', 'G7']);
  });
});
