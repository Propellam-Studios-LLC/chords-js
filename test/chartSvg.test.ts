import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { drawnLeadingKinds, drawnClosingKind } from '../src/chartSvg.js';

import { chartToSvg, chartModel, renderChart, chartBarId, chartChordId } from '../src/chart.js';
import { chartCss, layoutSymbol } from '../src/chartSvg.js';
import { qualityFor } from '../src/chartSymbolGlyphs.js';
import { parse } from '../src/parse.js';
import {
  CHART_GOLDEN_CASES,
  LONG_SYMBOL_DOC,
  BARNUMBERS_DOC,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — a plain .mjs data module shared with scripts/regen-golden.mjs
} from '../scripts/chart_golden_cases.mjs';

/**
 * The canonical SVG chart renderer.
 *
 * Two layers, on purpose:
 *
 * - **Goldens** pin the exact bytes, which is the determinism claim: the same
 *   input must produce the same SVG in Node and in a browser, forever, because
 *   nothing here measures text through a DOM. Regenerate deliberately with
 *   `npm run build && node scripts/regen-golden.mjs --charts`, and read the
 *   diff — the behavioural assertions below are what keep a refresh honest.
 * - **Behavioural assertions** state what must be true of the renderer *for a
 *   reason*: no duration fractions on the page, positional layout from `units`,
 *   drawn repeats and voltas, `P:` section labels, stable per-chord ids, real
 *   accidental glyphs, and the no-truncation invariant.
 */

const CORPUS = resolve(__dirname, 'fixtures/chart_corpus');
const GOLDEN = resolve(__dirname, 'fixtures/chart_golden');

interface Case {
  name: string;
  file?: string;
  text?: string;
  options: Record<string, unknown>;
}

function sourceOf(c: Case): string {
  return c.text ?? readFileSync(resolve(CORPUS, c.file as string), 'utf8');
}

const blueMoon = readFileSync(resolve(CORPUS, 'blue_moon.chords'), 'utf8');
const lotus = readFileSync(resolve(CORPUS, 'lotus_blossom.chords'), 'utf8');

/** Every `x`/`y` an element carries, parsed out of the SVG string. */
function attrs(svg: string, re: RegExp): string[] {
  return [...svg.matchAll(re)].map((m) => m[1]);
}

describe('chartSvg — goldens', () => {
  for (const c of CHART_GOLDEN_CASES as Case[]) {
    it(`${c.name} matches its golden`, () => {
      const path = resolve(GOLDEN, `${c.name}.svg`);
      expect(
        existsSync(path),
        `missing golden ${c.name}.svg — run: npm run build && node scripts/regen-golden.mjs --charts`,
      ).toBe(true);
      const { svg } = chartToSvg(sourceOf(c), c.options);
      expect(svg).toBe(readFileSync(path, 'utf8'));
    });
  }
});

describe('fraction suppression — duration is geometry, never text', () => {
  it('no `/2` or `2/3` ever reaches the page', () => {
    for (const notation of ['shorthand', 'classical'] as const) {
      const { svg } = chartToSvg(blueMoon, { notation });
      // Text content only: `/` inside a path `d=` or an attribute is fine.
      const text = [...svg.matchAll(/>([^<]*)</g)].map((m) => m[1]).join('|');
      expect(text).not.toMatch(/\d\s*\/\s*\d/);
    }
  });

  it("a half-bar pair is left-justified at the bar line and the half-bar point", () => {
    const { svg } = chartToSvg(blueMoon, { width: 720 });
    // Bar 0 is `Ebmaj7/2 Cm7/2`. Read the cell straight off its hit rect.
    const cell = /class="cc-bar-hit" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/.exec(
      svg.slice(svg.indexOf('id="cc-bar-0"')),
    ) as RegExpExecArray;
    const cellX = Number(cell[1]);
    const cellW = Number(cell[2]);
    const spans = ['cc-chord-0-0', 'cc-chord-0-1'].map((id) => {
      const g = svg.slice(svg.indexOf(`id="${id}"`));
      // The GLYPHS, not the group's transparent `cc-slot-hit` rect — that rect
      // is deliberately flush with the slot boundary (it is the tap target),
      // while this assertion is about where the ink lands.
      const sym = g.slice(g.indexOf('<text class="cc-sym">'), g.indexOf('</g>'));
      const xs = attrs(sym, /x="([\d.]+)"/g).map(Number);
      return { min: Math.min(...xs), max: Math.max(...xs) };
    });
    const mid = cellX + cellW / 2;
    // Each chord's ink STARTS at its own onset, not anywhere in its half.
    // Bar 0 opens with `|:`, so the first symbol also carries the repeat
    // indent — the second, mid-bar, does not. The indent is the glyph's own
    // ink reach (dots at x + 10, r = 1.9), so 11.9 past the slot gap.
    expect(spans[0].min).toBeCloseTo(cellX + 8 + 11.9, 1);
    expect(spans[0].max).toBeLessThan(mid);
    expect(spans[1].min).toBeCloseTo(mid + 8, 1);
    expect(spans[1].max).toBeLessThan(cellX + cellW);
  });

  it('a 2/3 + 1/3 bar sits at 1/3 and 5/6, not at quarters (lotus_blossom)', () => {
    const chart = chartModel(parse(lotus).form, { partsByLine: [] });
    const bar = chart.lines
      .flatMap((l) => l.bars)
      .find((b) => b.chords.length === 2 && Math.abs(b.chords[0].weight - 2 / 3) < 1e-6);
    expect(bar, 'the Em7b5 2/3 + Ebm7b5 1/3 bar').toBeDefined();
    const [a, b] = (bar as NonNullable<typeof bar>).chords;
    // Centres of each chord's own share of the cell.
    expect(a.offset + a.weight / 2).toBeCloseTo(1 / 3, 9);
    expect(b.offset + b.weight / 2).toBeCloseTo(5 / 6, 9);
  });
});

describe('structure is DRAWN, not spelled', () => {
  const { svg } = chartToSvg(blueMoon);

  it('draws repeat barlines with dots', () => {
    expect(svg).toContain('cc-barline--repeatOpen');
    expect(svg).toContain('cc-barline--repeatClose');
    expect(svg).toContain('cc-repeat-dot');
    expect(svg).toContain('cc-barline--final');
  });

  it('draws both volta brackets, mid-chart', () => {
    expect(svg).toContain('data-volta="1"');
    expect(svg).toContain('data-volta="2"');
    expect(svg).toContain('cc-volta-bracket');
    expect(svg).toContain('>1.<');
    expect(svg).toContain('>2.<');
  });

  it('boxes the P: section labels in order', () => {
    const labels = attrs(svg, /class="cc-part"[^>]*>([^<]*)</g);
    expect(labels).toEqual(['A', 'B', 'A2']);
    expect(svg).toContain('cc-part-box');
  });

  it('starts a new section on every label CHANGE, not per distinct label', () => {
    const chart = chartToSvg(lotus).model;
    const parts = chart.sections.map((s) => s.part);
    // lotus_blossom repeats `A` and `ToCod` several times — each run is its own
    // section, so the label list has duplicates and is longer than the set.
    expect(parts.length).toBeGreaterThan(new Set(parts).size);
    expect(parts[0]).toBe('A');
    expect(parts).toContain('Coda');
  });
});

describe('addressable hooks — the host contract', () => {
  const { svg, model } = chartToSvg(blueMoon);

  it('gives every bar and chord a stable, unique, written-order id', () => {
    const ids = attrs(svg, /id="(cc-chord-[\d-]+)"/g);
    expect(new Set(ids).size).toBe(ids.length);
    const flat = model.lines.flatMap((l) => l.bars);
    for (const bar of flat) {
      expect(svg).toContain(`id="${chartBarId(bar.index)}"`);
      for (const chord of bar.chords) {
        expect(svg).toContain(`id="${chartChordId(bar.index, chord.index)}"`);
      }
    }
  });

  it('carries the data- attributes hosts key on', () => {
    expect(svg).toContain('data-bar="0"');
    expect(svg).toContain('data-slot="1"');
    expect(svg).toContain('data-units="0.5"');
    expect(svg).toContain('data-measure="1"');
    expect(svg).toMatch(/data-bars="\d+"/);
  });

  it('gives every bar a transparent hit rect for taps', () => {
    expect(svg).toContain('class="cc-bar-hit"');
  });

  it('embeds a CSS-variable stylesheet defining the state classes', () => {
    for (const cls of ['is-correct', 'is-wrong', 'is-missed', 'is-active', 'is-active-row', 'is-dim']) {
      expect(chartCss).toContain(cls);
    }
    expect(chartCss).toContain('--cc-ink');
    expect(chartCss).toContain('prefers-color-scheme: dark');
    expect(svg).toContain('<style>');
  });

  it('roman mode emits the SAME id set as letters — the toggle keeps overlays', () => {
    const letters = attrs(chartToSvg(blueMoon).svg, /id="(cc-chord-[\d-]+)"/g);
    const roman = attrs(chartToSvg(blueMoon, { mode: 'roman' }).svg, /id="(cc-chord-[\d-]+)"/g);
    expect(roman).toEqual(letters);
  });
});

describe('typography', () => {
  it('uses real accidental glyphs, never ASCII b/#', () => {
    const { svg } = chartToSvg(blueMoon, { notation: 'classical' });
    expect(svg).toContain('E♭');
    expect(svg).not.toContain('>Eb<');
    expect(chartToSvg(lotus).svg).toContain('♯11');
  });

  it('shorthand is the iReal-Pro vocabulary; classical writes it out', () => {
    // '△7', not a bare triangle — the seventh is part of the spelling.
    expect(chartToSvg(blueMoon).svg).toContain('>△7<');
    expect(chartToSvg(blueMoon, { notation: 'classical' }).svg).toContain('>maj7<');
    expect(chartToSvg(blueMoon).svg).toContain('>ø7<'); // Gm7b5
    expect(chartToSvg(blueMoon, { notation: 'classical' }).svg).toContain('>m7♭5<');
  });

  it('roman always renders classically, whatever the notation asks for', () => {
    const a = chartToSvg(blueMoon, { mode: 'roman' });
    const b = chartToSvg(blueMoon, { mode: 'roman', notation: 'shorthand' });
    expect(a.svg).toBe(b.svg);
    expect(a.model.notation).toBe('classical');
    expect(a.svg).toContain('>maj7<');
  });

  it('splits root / quality / alteration / bass into addressable tspans', () => {
    const { svg } = chartToSvg(LONG_SYMBOL_DOC, { width: 360 });
    expect(svg).toContain('class="cc-root"');
    expect(svg).toContain('class="cc-qual"');
    expect(svg).toContain('class="cc-alt"');
    expect(svg).toContain('class="cc-bass"');
  });
});

describe('NO TRUNCATION', () => {
  for (const notation of ['shorthand', 'classical'] as const) {
    it(`renders a long symbol WHOLE in a narrow chart (${notation})`, () => {
      const { svg } = chartToSvg(LONG_SYMBOL_DOC, { width: 300, notation });
      // Never an ellipsis, in any form.
      expect(svg).not.toContain('…');
      expect(svg).not.toContain('text-overflow');
      expect(svg).not.toMatch(/>\w+\.\.\.</);
      // The whole symbol is present: root, quality, alteration and bass.
      const chord = svg.slice(svg.indexOf('id="cc-chord-0-0"'));
      const body = chord.slice(0, chord.indexOf('</g>'));
      const text = [...body.matchAll(/>([^<]*)</g)].map((m) => m[1]).join('');
      expect(text).toContain('D♭');
      expect(text).toContain('♯11');
      expect(text).toContain('/A♭');
      expect(text.replace(/[△]/, 'maj7')).toMatch(/D♭maj7|D♭.*7/);
    });
  }

  it('every glyph stays inside the chart box', () => {
    const { svg, width } = chartToSvg(LONG_SYMBOL_DOC, { width: 300 });
    const xs = attrs(svg, /<tspan[^>]*\sx="(-?[\d.]+)"/g).map(Number);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(width);
  });

  it('keeps cells UNIFORM and shrinks a crowded symbol to fit', () => {
    // One bar full of long symbols beside three short ones. The grid stays
    // uniform — the crowded bar does NOT balloon — and the long symbol shrinks
    // to fit its cell rather than the cell widening to fit it. It is still
    // rendered WHOLE, never clipped.
    const doc = [
      '%chords-1.0',
      'M: 4/4',
      'L: 1/1',
      'K: C',
      'Dbmaj7#11/Ab | C | C | C |]',
    ].join('\n');
    const { svg } = chartToSvg(doc, { width: 300 });
    const hits = [...svg.matchAll(/class="cc-bar-hit" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)]
      .map((m) => ({ x: Number(m[1]), w: Number(m[2]) }));
    expect(hits).toHaveLength(4);
    // Every cell the same width — the iReal-Pro grid.
    for (const h of hits) expect(h.w).toBeCloseTo(hits[0].w, 6);
    // …and the cells still tile the line exactly.
    const total = hits.reduce((s, h) => s + h.w, 0);
    expect(total).toBeCloseTo(300 - 24, 1);
    // The long symbol is present in full — root, alteration and bass — not an
    // ellipsis and not a shorter fallback spelling.
    const chord = svg.slice(svg.indexOf('id="cc-chord-0-0"'));
    const body = chord.slice(0, chord.indexOf('</g>'));
    const text = [...body.matchAll(/>([^<]*)</g)].map((m) => m[1]).join('');
    expect(text).toContain('D♭');
    expect(text).toContain('♯11');
    expect(text).toContain('/A♭');
    expect(svg).not.toContain('…');
  });

  it("keeps the mode's symbol vocabulary — never a shorter fallback spelling", () => {
    // A truncation-by-another-name would be silently swapping to shorthand.
    const { svg } = chartToSvg(LONG_SYMBOL_DOC, { width: 300, notation: 'classical' });
    expect(svg).toContain('maj7');
    expect(svg).not.toContain('>△<');
  });
});

describe('%%barnumbers', () => {
  it('draws measure numbers at the directive interval, offset by %%setbarnb', () => {
    const { svg, model } = chartToSvg(BARNUMBERS_DOC);
    expect(model.barNumbers).toBe(4);
    // %%setbarnb 9 → bars are numbered 9..16; every 4th printed = 12 and 16.
    const nums = attrs(svg, /class="cc-barnum"[^>]*>(\d+)</g);
    expect(nums).toEqual(['12', '16']);
    expect(svg).toContain('data-measure="9"');
  });

  it('draws nothing when the document carries no directive', () => {
    const { svg, model } = chartToSvg(blueMoon);
    expect(model.barNumbers).toBeNull();
    expect(svg).not.toContain('class="cc-barnum"');
  });

  it('an unrecognised directive passes through the parser without erroring', () => {
    const doc = BARNUMBERS_DOC.replace('%%setbarnb 9', '%%staffwidth 500');
    const parsed = parse(doc);
    expect(parsed.errors).toEqual([]);
    expect(parsed.directives.staffwidth).toBe('500');
    expect(parsed.directives.barnumbers).toBe('4');
  });
});

describe('entry points', () => {
  it('chartToSvg and renderChart agree byte for byte', () => {
    const el = document.createElement('div');
    const injected = renderChart(el, blueMoon);
    expect(injected.svg).toBe(chartToSvg(blueMoon).svg);
    expect(injected.element).toBe(el);
    expect(el.querySelector('.cc-chart')).not.toBeNull();
  });

  it('injects the whole tree, addressable by class', () => {
    // `embedCss: false` because happy-dom's HTML parser drops everything after a
    // `<style>` inside an `<svg>` — a test-environment limitation, not a
    // renderer one (browsers and WebViews handle inline SVG `<style>` fine,
    // which is exactly why the CSS is embedded by default).
    const el = document.createElement('div');
    const r = renderChart(el, blueMoon, { embedCss: false });
    const chords = r.model.lines.flatMap((l) => l.bars).flatMap((b) => b.chords);
    expect(el.querySelectorAll('.cc-chord')).toHaveLength(chords.length);
    expect(el.querySelector(`#${chartChordId(0, 1)}`)).not.toBeNull();
    expect(el.querySelectorAll('.cc-bar')).toHaveLength(r.model.barCount);
  });

  it('renderChartFromForm renders a stored form (no .chords text)', async () => {
    const { renderChartFromForm } = await import('../src/chart.js');
    const el = document.createElement('div');
    const r = renderChartFromForm(el, parse(blueMoon).form);
    expect(r.model.barCount).toBe(parse(blueMoon).form.bars.length);
    // No section labels without partsByLine — the stored form carries none.
    expect(r.svg).not.toContain('<text class="cc-part"');
  });

  it('throws, naming the selector, when the element is missing', () => {
    expect(() => renderChart('does-not-exist', blueMoon)).toThrow(/does-not-exist/);
  });
});

describe('entry annotations', () => {
  const doc = ['X:1', 'T:Two', 'K:C', 'L:1', '| C | G G |'].join('\n');

  it('draws a parenthetical entry under the named slot only', () => {
    const plain = chartToSvg(doc, { embedCss: false });
    expect(plain.svg).not.toContain('cc-annot-entry');

    const r = chartToSvg(doc, {
      embedCss: false,
      // Bar 1's second slot only.
      entryAnnotations: [[null], [null, 'Am7']],
    });
    const hits = r.svg.match(/class="cc-annot-entry"/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(r.svg).toContain('>(Am7)</text>');
  });

  it('puts the annotation INSIDE its chord group, so a state class colours it', () => {
    const el = document.createElement('div');
    renderChart(el, doc, {
      embedCss: false,
      entryAnnotations: [[null], [null, 'Am7']],
    });
    const slot = el.querySelector(`#${chartChordId(1, 1)}`);
    expect(slot).not.toBeNull();
    expect(slot!.querySelector('.cc-annot-entry')?.textContent).toBe('(Am7)');
    // The stylesheet paints it with the slot's verdict rather than separately.
    expect(chartCss).toContain('.cc-chord.is-wrong .cc-annot-entry');
  });

  it('escapes annotation text and never truncates it', () => {
    const r = chartToSvg(doc, {
      embedCss: false,
      entryAnnotations: [['A&B<C>'], []],
    });
    expect(r.svg).toContain('(A&amp;B&lt;C&gt;)');
    expect(r.svg).not.toContain('…');
  });

  it('is unaffected by a ragged or short matrix', () => {
    expect(() =>
      chartToSvg(doc, { embedCss: false, entryAnnotations: [] }),
    ).not.toThrow();
  });
});

describe('per-slot hit rects and the selection class', () => {
  const doc = ['X:1', 'T:Split', 'K:C', 'L:1', '| C | G/2 Am/2 |', '| | F |'].join('\n');

  it('gives every chord slot its own transparent hit rect', () => {
    const el = document.createElement('div');
    const r = renderChart(el, doc, { embedCss: false });
    const chords = r.model.lines.flatMap((l) => l.bars).flatMap((b) => b.chords);
    expect(el.querySelectorAll('.cc-slot-hit')).toHaveLength(chords.length);
    // A split bar has two, and they are the two halves of the cell.
    const split = el.querySelector(`#${chartBarId(1)}`)!;
    const rects = [...split.querySelectorAll('.cc-slot-hit')];
    expect(rects).toHaveLength(2);
    const [a, b] = rects.map((n) => Number(n.getAttribute('x')));
    expect(b).toBeGreaterThan(a);
  });

  it('gives each bar exactly as many slot rects as it has chords — an EMPTY bar has none and falls through to its bar rect', async () => {
    const { renderChartFromForm } = await import('../src/chart.js');
    // A part-filled entry grid, as a host renders it while the user is still
    // filling it in. `.chords` TEXT cannot express a chordless bar, but a
    // hand-built form can, and that is the case that must be tappable.
    const form = {
      meter: '4/4',
      unitLength: 1,
      key: 'C',
      bars: [
        { chords: [], leadingBarline: 'plain', line: 0 },
        {
          chords: [{ root: 'G', type: 'maj', units: 1, degree: 'V' }],
          leadingBarline: 'plain',
          line: 0,
        },
      ],
      finalBarline: 'final',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const el = document.createElement('div');
    const r = renderChartFromForm(el, form, { embedCss: false });
    const bars = r.model.lines.flatMap((l) => l.bars);
    expect(bars.map((b) => b.chords.length)).toEqual([0, 1]);
    for (const bar of bars) {
      const g = el.querySelector(`#${chartBarId(bar.index)}`)!;
      expect(g.querySelectorAll('.cc-slot-hit')).toHaveLength(bar.chords.length);
      expect(g.querySelector('.cc-bar-hit')).not.toBeNull();
    }
  });

  it('styles is-selected distinctly from is-active (two vocabularies)', () => {
    expect(chartCss).toContain('--cc-selected-tint');
    expect(chartCss).toContain('.cc-chord.is-selected .cc-slot-hit');
    // Selection and playback must not resolve to the same variable.
    expect(chartCss).not.toMatch(/--cc-selected-tint:\s*var\(--cc-active-tint\)/);
  });
});

// --------------------------------------------------------------------------- //
// Onset justification and the repeat indent
// --------------------------------------------------------------------------- //

/** The cell rect (x, width) of a bar, straight off its `cc-bar-hit`. */
function cellOf(svg: string, bar: number): { x: number; w: number } {
  const m = /class="cc-bar-hit" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/.exec(
    svg.slice(svg.indexOf(`id="cc-bar-${bar}"`)),
  ) as RegExpExecArray;
  return { x: Number(m[1]), w: Number(m[2]) };
}

/** Where a chord's INK starts — the leftmost glyph x, never the hit rect. */
function inkStart(svg: string, bar: number, slot: number): number {
  const g = svg.slice(svg.indexOf(`id="cc-chord-${bar}-${slot}"`));
  const sym = g.slice(g.indexOf('<text class="cc-sym">'), g.indexOf('</g>'));
  return Math.min(...attrs(sym, /x="([\d.]+)"/g).map(Number));
}

function doc(body: string, header = 'M: 4/4'): string {
  return ['%chords-1.0', 'T: Justify', header, 'L: 1/1', 'K: C', body].join('\n');
}

describe('subdivision justification', () => {
  // The quantization is ONSET-DERIVED from the progression's own duration
  // fractions. No meter is consulted — a `/3` bar lands on thirds because it
  // is written in thirds, not because the piece is in 3/4.
  const SLOT_GAP = 8;

  it('a lone chord is left-justified at the bar line', () => {
    const { svg } = chartToSvg(doc('C | F | G | C |]'), { width: 720 });
    const cell = cellOf(svg, 0);
    expect(inkStart(svg, 0, 0)).toBeCloseTo(cell.x + SLOT_GAP, 1);
  });

  it('a two-chord bar reads at 0 and 1/2', () => {
    const { svg } = chartToSvg(doc('C/2 G/2 | F | G | C |]'), { width: 720 });
    const { x, w } = cellOf(svg, 0);
    expect(inkStart(svg, 0, 0)).toBeCloseTo(x + SLOT_GAP, 1);
    expect(inkStart(svg, 0, 1)).toBeCloseTo(x + w / 2 + SLOT_GAP, 1);
  });

  it('a THREE-chord bar reads at thirds — from its own fractions', () => {
    const { svg } = chartToSvg(doc('C/3 F/3 G/3 | F | G | C |]'), { width: 720 });
    const { x, w } = cellOf(svg, 0);
    expect(inkStart(svg, 0, 0)).toBeCloseTo(x + SLOT_GAP, 1);
    expect(inkStart(svg, 0, 1)).toBeCloseTo(x + w / 3 + SLOT_GAP, 1);
    expect(inkStart(svg, 0, 2)).toBeCloseTo(x + (2 * w) / 3 + SLOT_GAP, 1);
  });

  it('a MIXED /4 + /2 + /4 bar reads at 0, 1/4 and 3/4 — not at even thirds', () => {
    const { svg } = chartToSvg(doc('C/4 F/2 G/4 | F | G | C |]'), { width: 720 });
    const { x, w } = cellOf(svg, 0);
    expect(inkStart(svg, 0, 0)).toBeCloseTo(x + SLOT_GAP, 1);
    expect(inkStart(svg, 0, 1)).toBeCloseTo(x + w / 4 + SLOT_GAP, 1);
    expect(inkStart(svg, 0, 2)).toBeCloseTo(x + (3 * w) / 4 + SLOT_GAP, 1);
    // The middle chord is NOT at 1/3 — durations, not slot count, place it.
    expect(inkStart(svg, 0, 1)).not.toBeCloseTo(x + w / 3 + SLOT_GAP, 1);
  });

  it('a four-chord bar reads at quarters', () => {
    const { svg } = chartToSvg(doc('C/4 F/4 G/4 C/4 | F | G | C |]'), { width: 720 });
    const { x, w } = cellOf(svg, 0);
    for (let k = 0; k < 4; k++) {
      expect(inkStart(svg, 0, k)).toBeCloseTo(x + (k * w) / 4 + SLOT_GAP, 1);
    }
  });

  it('the meter is irrelevant — 3/4 and 4/4 place the same fractions alike', () => {
    const body = 'C/2 G/2 | F | G | C |]';
    const a = chartToSvg(doc(body, 'M: 4/4'), { width: 720 }).svg;
    const b = chartToSvg(doc(body, 'M: 3/4'), { width: 720 }).svg;
    expect(inkStart(b, 0, 0)).toBeCloseTo(inkStart(a, 0, 0), 6);
    expect(inkStart(b, 0, 1)).toBeCloseTo(inkStart(a, 0, 1), 6);
  });

  it('the first chord past a BEGIN-repeat clears the repeat dots', () => {
    const plain = chartToSvg(doc('C | F | G | C |]'), { width: 720 }).svg;
    const rep = chartToSvg(doc('|: C | F | G | C :|]'), { width: 720 }).svg;
    const indent = inkStart(rep, 0, 0) - inkStart(plain, 0, 0);
    // `repeatOpen`'s ink reach: dots at x + 10 with r = 1.9, derived from the
    // drawn glyph rather than a separate constant that could drift from it.
    expect(indent).toBeCloseTo(11.9, 6);
    // …and it really is clear of the ink: the rightmost dot of the OPENING
    // ornament (the ones near the line's left edge — the closing repeat's dots
    // live at the far right) sits left of where the symbol starts.
    const { x } = cellOf(rep, 0);
    const opening = attrs(rep, /class="cc-repeat-dot" cx="([\d.]+)"/g)
      .map(Number)
      .filter((cx) => cx < x + 20);
    expect(opening.length).toBeGreaterThan(0);
    expect(Math.max(...opening) + 1.9).toBeLessThan(inkStart(rep, 0, 0));
  });

  it('only the FIRST chord of the bar is indented', () => {
    const rep = chartToSvg(doc('|: C/2 G/2 | F | G | C :|]'), { width: 720 }).svg;
    const { x, w } = cellOf(rep, 0);
    expect(inkStart(rep, 0, 0)).toBeCloseTo(x + 8 + 11.9, 1);
    expect(inkStart(rep, 0, 1)).toBeCloseTo(x + w / 2 + 8, 1);
  });

  it('a line-start bar whose stored leading barline is `:|` gets NO indent', () => {
    // A closing-type ornament at a line start is flattened — it is already
    // drawn as the previous line's closing barline. An indent computed from the
    // raw field would shift a bar whose ornament is never drawn.
    const four = chartToSvg(doc('C | F | G | C :|\nF | G | C | C |]'), {
      width: 720,
    }).svg;
    const plain = chartToSvg(doc('C | F | G | C |\nF | G | C | C |]'), {
      width: 720,
    }).svg;
    // Bar 4 opens line 2 in both; its ink must land identically.
    expect(inkStart(four, 4, 0)).toBeCloseTo(inkStart(plain, 4, 0), 6);
  });

  it('the fit-scale accounts for the indent, so ink never overruns its neighbour', () => {
    // A narrow chart with a repeat and a split bar: the two symbols may shrink,
    // but the first must still end before the second begins.
    const { svg } = chartToSvg(
      doc('|: Dbmaj7#11/Ab/2 Abm7b5/Gb/2 | F | G | C :|]'),
      { width: 380 },
    );
    const g = svg.slice(svg.indexOf('id="cc-chord-0-0"'));
    const sym = g.slice(g.indexOf('<text class="cc-sym">'), g.indexOf('</g>'));
    const firstMax = Math.max(...attrs(sym, /x="([\d.]+)"/g).map(Number));
    expect(firstMax).toBeLessThan(inkStart(svg, 0, 1));
  });
});

// --------------------------------------------------------------------------- //
// Row numbers
// --------------------------------------------------------------------------- //

describe('row numbers', () => {
  const twoLines = doc('C | F | G | C |\nAm | Dm | G7 | C |]');

  it('prints nothing by default', () => {
    const { svg } = chartToSvg(twoLines, { width: 720 });
    // The stylesheet always DEFINES the class (it is one embedded sheet); what
    // must be absent is any element wearing it.
    expect(svg).not.toContain('<text class="cc-rownum"');
  });

  it('prints one ABSOLUTE, 1-based number per line, in order', () => {
    const { svg } = chartToSvg(twoLines, { width: 720, rowNumbers: true });
    const nums = [...svg.matchAll(/class="cc-rownum"[^>]*>(\d+)</g)].map((m) => m[1]);
    expect(nums).toEqual(['1', '2']);
  });

  it('emits each number INSIDE its own cc-line group (so a crop keeps it)', () => {
    const { svg } = chartToSvg(twoLines, { width: 720, rowNumbers: true });
    const lineOpens = [...svg.matchAll(/<g class="cc-line" data-line="(\d+)"/g)];
    const rowNums = [...svg.matchAll(/class="cc-rownum"[^>]*>(\d+)</g)];
    expect(lineOpens).toHaveLength(2);
    expect(rowNums).toHaveLength(2);
    // line0 open < its number < line1 open < its number
    expect(lineOpens[0].index!).toBeLessThan(rowNums[0].index!);
    expect(rowNums[0].index!).toBeLessThan(lineOpens[1].index!);
    expect(lineOpens[1].index!).toBeLessThan(rowNums[1].index!);
  });

  it('reserves a gutter — the first bar line moves right, cells stay uniform', () => {
    const plain = chartToSvg(twoLines, { width: 720 }).svg;
    const numbered = chartToSvg(twoLines, { width: 720, rowNumbers: true }).svg;
    expect(cellOf(numbered, 0).x - cellOf(plain, 0).x).toBeCloseTo(22, 6);
    const widths = [0, 1, 2, 3].map((b) => cellOf(numbered, b).w);
    for (const w of widths) expect(w).toBeCloseTo(widths[0], 6);
    expect(widths[0]).toBeLessThan(cellOf(plain, 0).w);
  });

  it('the number is styled from a --cc-* variable, never a literal', () => {
    expect(chartCss).toContain('.cc-rownum');
    expect(chartCss).toMatch(/\.cc-rownum \{ fill: var\(--cc-muted\)/);
  });
});

// --------------------------------------------------------------------------- //
// The DOM entry points fit the container they render into
// --------------------------------------------------------------------------- //

describe('container fit', () => {
  it('renderChart uses the element clientWidth when no width is given', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 358, configurable: true });
    const r = renderChart(el, doc('C | F | G | C |]'), { embedCss: false });
    expect(r.width).toBe(358);
    expect(r.svg).toContain('width="358"');
  });

  it('an explicit width still wins', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 358, configurable: true });
    const r = renderChart(el, doc('C | F | G | C |]'), {
      embedCss: false,
      width: 500,
    });
    expect(r.width).toBe(500);
  });

  it('an unlaid-out element (clientWidth 0) keeps the default, not a zero chart', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 0, configurable: true });
    const r = renderChart(el, doc('C | F | G | C |]'), { embedCss: false });
    expect(r.width).toBe(720);
  });

  it('chartToSvg stays DOM-free — its default is untouched', () => {
    expect(chartToSvg(doc('C | F | G | C |]')).width).toBe(720);
  });
});

// --------------------------------------------------------------------------- //
// The shrink is per SYMBOL, never per row
// --------------------------------------------------------------------------- //

/** The root tspan's font-size for one chord. */
function rootSize(svg: string, bar: number, slot: number): number {
  const g = svg.slice(svg.indexOf(`id="cc-chord-${bar}-${slot}"`));
  const m = /class="cc-root"[^>]*font-size="([\d.]+)"/.exec(g) as RegExpExecArray;
  return Number(m[1]);
}

describe('per-symbol font shrink', () => {
  // Three short single-chord measures, then a crowded one holding a long
  // symbol. Only the symbol that overruns its own slot may shrink; the other
  // measures must not inherit the crowded bar's scale.
  const moonglowRow = doc('C | F | G | Abm7b5/3 C/3 G/3 |]');

  it('single-chord measures keep full size on a row with a crowded measure', () => {
    const { svg } = chartToSvg(moonglowRow, { width: 400 });
    const full = rootSize(chartToSvg(doc('C | F | G | C |]'), { width: 400 }).svg, 0, 0);
    expect(rootSize(svg, 0, 0)).toBe(full);
    expect(rootSize(svg, 1, 0)).toBe(full);
    expect(rootSize(svg, 2, 0)).toBe(full);
  });

  it('inside the crowded measure only the long symbol shrinks', () => {
    const { svg } = chartToSvg(moonglowRow, { width: 400 });
    const full = rootSize(svg, 0, 0);
    expect(rootSize(svg, 3, 0)).toBeLessThan(full); // Abm7b5 — too wide for a third
    expect(rootSize(svg, 3, 1)).toBe(full); // C fits its third
    expect(rootSize(svg, 3, 2)).toBe(full); // G fits its third
  });

  it('no symbol overruns its own slot', () => {
    const { svg } = chartToSvg(moonglowRow, { width: 400 });
    const { x, w } = cellOf(svg, 3);
    const g = svg.slice(svg.indexOf('id="cc-chord-3-0"'));
    const sym = g.slice(g.indexOf('<text class="cc-sym">'), g.indexOf('</g>'));
    const rightmost = Math.max(...attrs(sym, /x="([\d.]+)"/g).map(Number));
    expect(rightmost).toBeLessThan(x + w / 3 + 8); // its third of the cell
  });
});

describe('the shorthand qualifier stack is ONE subscript run', () => {
  const parts = (canonical: string, notation: 'shorthand' | 'classical') => {
    const { quality, alterations } = qualityFor(canonical, notation);
    return { root: 'C', quality, alterations, bass: '' };
  };

  it('shorthand puts the alterations on the quality\'s own baseline', () => {
    // In 7#9 all three characters are one subscript run: the #9 sits on the
    // 7's dropped baseline rather than being raised as a superscript.
    const { pieces } = layoutSymbol(parts('7#9', 'shorthand'), 20, 'shorthand');
    const qual = pieces.find((p) => p.cls === 'cc-qual')!;
    const alt = pieces.find((p) => p.cls === 'cc-alt')!;
    expect(alt.dy).toBe(qual.dy);
    expect(qual.dy).toBeGreaterThan(0); // dropped, not raised
  });

  it('classical keeps the small raised alteration column', () => {
    const { pieces } = layoutSymbol(parts('7#9', 'classical'), 20, 'classical');
    const root = pieces.find((p) => p.cls === 'cc-root')!;
    const alt = pieces.find((p) => p.cls === 'cc-alt');
    // The classical spelling carries its alteration inside the quality run, so
    // there may be no separate cc-alt at all; when there is, it rides ABOVE the
    // root's baseline (a negative dy is upward in this coordinate space).
    if (alt) expect(alt.dy).toBeLessThan(root.dy);
  });

  it('a stacked pair still ends on the quality line in shorthand', () => {
    const stacked = { root: 'C', quality: '7', alterations: ['♭9', '♯11'], bass: '' };
    const { pieces } = layoutSymbol(stacked, 20, 'shorthand');
    const alts = pieces.filter((p) => p.cls === 'cc-alt');
    const qual = pieces.find((p) => p.cls === 'cc-qual')!;
    expect(alts).toHaveLength(2);
    expect(alts[1].dy).toBe(qual.dy);
    expect(alts[0].dy).toBeLessThan(alts[1].dy);
  });

  it('a major seventh renders its 7 in shorthand', () => {
    const { svg } = chartToSvg('title: T\nkey: C\n\n| Cmaj7 |\n', {
      notation: 'shorthand',
    });
    expect(svg).toContain('>△7<');
  });
});

// --------------------------------------------------------------------------- //
// One grid for the whole chart, and volta alignment
// --------------------------------------------------------------------------- //

describe('uniform measure width across rows', () => {
  // Every measure has the same width however many measures its line holds: a
  // row of two measures uses the same cell width as a full row of four.
  const shortLast = doc('C | F | G | C |\nAm | Dm |]');

  it("a two-bar row's cells are as wide as a four-bar row's", () => {
    const { svg } = chartToSvg(shortLast, { width: 720 });
    const full = cellOf(svg, 0).w;
    for (const bar of [1, 2, 3, 4, 5]) {
      expect(cellOf(svg, bar).w).toBeCloseTo(full, 6);
    }
  });

  it('the short row is LEFT-aligned — it starts where the full rows start', () => {
    const { svg } = chartToSvg(shortLast, { width: 720 });
    expect(cellOf(svg, 4).x).toBeCloseTo(cellOf(svg, 0).x, 6);
    // ...and leaves the rest of the row empty rather than stretching into it.
    const right = cellOf(svg, 5).x + cellOf(svg, 5).w;
    expect(right).toBeLessThan(cellOf(svg, 3).x + cellOf(svg, 3).w - 1);
  });

  it('a single-bar row is one column wide', () => {
    const { svg } = chartToSvg(doc('C | F | G | C |\nAm |]'), { width: 720 });
    expect(cellOf(svg, 4).w).toBeCloseTo(cellOf(svg, 0).w, 6);
  });

  it('the grid follows the WIDEST row when it exceeds barsPerLine', () => {
    // Six authored bars on one line, four on the next: every cell is avail/6.
    const wide = doc('C | F | G | C | Am | Dm |\nC | F | G | C |]');
    const { svg } = chartToSvg(wide, { width: 720 });
    const w = cellOf(svg, 0).w;
    for (const bar of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(cellOf(svg, bar).w).toBeCloseTo(w, 6);
    }
    // Six columns: the row of six spans the frame, the row of four does not.
    const sixRight = cellOf(svg, 5).x + cellOf(svg, 5).w;
    const fourRight = cellOf(svg, 9).x + cellOf(svg, 9).w;
    expect(fourRight).toBeLessThan(sixRight - 1);
  });
});

describe('volta endings align', () => {
  // Equal-length endings, each on its own row after a two-bar lead-in.
  const equal = doc(
    '|: C | F |[1 G | C |\n:|[2 Am | Dm |]',
  );

  it('the second ending is indented to the first ending\'s column', () => {
    const { svg } = chartToSvg(equal, { width: 720 });
    // Ending 1 is bars 2-3; ending 2 is bars 4-5.
    expect(cellOf(svg, 4).x).toBeCloseTo(cellOf(svg, 2).x, 6);
    expect(cellOf(svg, 5).x).toBeCloseTo(cellOf(svg, 3).x, 6);
  });

  it('cells keep their grid width — the indent never shrinks them', () => {
    const { svg } = chartToSvg(equal, { width: 720 });
    const w = cellOf(svg, 0).w;
    for (const bar of [1, 2, 3, 4, 5]) expect(cellOf(svg, bar).w).toBeCloseTo(w, 6);
  });

  it('an unequal second ending still STARTS at the first ending\'s column', () => {
    const { svg } = chartToSvg(doc('|: C | F | G |[1 C |\n:|[2 Am |]'), {
      width: 720,
    });
    // Ending 1 is bar 3 (column 3); ending 2 is bar 4, alone on its row.
    expect(cellOf(svg, 4).x).toBeCloseTo(cellOf(svg, 3).x, 6);
  });

  it('drops the indent rather than overflowing when it cannot fit', () => {
    // Ending 1 starts in column 3; ending 2 is two bars, so 3 + 2 > 4.
    const { svg } = chartToSvg(doc('|: C | F | G |[1 C |\n:|[2 Am | Dm |]'), {
      width: 720,
    });
    expect(cellOf(svg, 4).x).toBeCloseTo(cellOf(svg, 0).x, 6);
    expect(cellOf(svg, 4).w).toBeCloseTo(cellOf(svg, 0).w, 6);
  });

  it('leaves a chart with no voltas exactly where it was', () => {
    const { svg } = chartToSvg(doc('C | F | G | C |\nAm | Dm | G7 | C |]'), {
      width: 720,
    });
    for (const bar of [0, 4]) expect(cellOf(svg, bar).x).toBeCloseTo(cellOf(svg, 0).x, 6);
  });

  it('keeps the row-number gutter at the frame edge, not with the indent', () => {
    const plain = chartToSvg(equal, { width: 720, rowNumbers: true }).svg;
    const nums = [...plain.matchAll(/class="cc-rownum" x="([\d.]+)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(nums).toHaveLength(2);
    expect(nums[1]).toBeCloseTo(nums[0], 6);
  });

  it('the volta bracket follows its indented row', () => {
    const { svg } = chartToSvg(equal, { width: 720 });
    const brackets = [...svg.matchAll(/data-volta="(\d)"[\s\S]{0,120}?d="M([\d.]+) /g)];
    expect(brackets).toHaveLength(2);
    expect(Number(brackets[1][2])).toBeCloseTo(Number(brackets[0][2]), 6);
  });
});

// --------------------------------------------------------------------------- //
// The chord↔closing-repeat overlap, and the `:||:` glyph
// --------------------------------------------------------------------------- //

/** Where a chord's INK ends — the rightmost glyph x plus its rendered width. */
function inkEnd(svg: string, bar: number, slot: number): number {
  const g = svg.slice(svg.indexOf(`id="cc-chord-${bar}-${slot}"`));
  const sym = g.slice(g.indexOf('<text class="cc-sym">'), g.indexOf('</g>'));
  const xs = attrs(sym, /x="([\d.]+)"/g).map(Number);
  const sizes = attrs(sym, /font-size="([\d.]+)"/g).map(Number);
  // A conservative advance for the last tspan: glyph widths are ~0.62em for the
  // symbol font, so 0.62 * size per character over-estimates rather than under.
  const lastIdx = xs.indexOf(Math.max(...xs));
  const texts = [...sym.matchAll(/font-size="[\d.]+">([^<]*)</g)].map((m) => m[1]);
  const text = texts[lastIdx] ?? '';
  return Math.max(...xs) + text.length * 0.62 * (sizes[lastIdx] ?? 12);
}

/** Every repeat-dot cx in the SVG. */
function repeatDotXs(svg: string): number[] {
  return attrs(svg, /class="cc-repeat-dot" cx="([\d.-]+)"/g).map(Number);
}

describe('the last chord never collides with the closing repeat', () => {
  for (const [name, body] of [
    ['repeatClose', 'Cmaj7#11 | F | G | Cmaj7#11 :|]'],
    ['repeatBoth', 'Cmaj7#11 | F :||: G | Cmaj7#11 |]'],
    ['final', 'Cmaj7#11 | F | G | Cmaj7#11 |]'],
    ['plain', 'Cmaj7#11 | F | G | Cmaj7#11 |'],
  ] as [string, string][]) {
    it(`clears a ${name} closing barline`, () => {
      const svg = chartToSvg(doc(body), { width: 420 }).svg;
      // The bar whose closing barline carries repeat dots: assert the last
      // chord's ink ends left of the leftmost dot of that ornament.
      const dots = repeatDotXs(svg);
      for (let bar = 0; bar < 4; bar++) {
        const end = inkEnd(svg, bar, 0);
        const { x, w } = cellOf(svg, bar);
        const barRight = x + w;
        const leftward = dots.filter((d) => d < barRight + 1 && d > barRight - 20);
        if (leftward.length === 0) continue;
        expect(end).toBeLessThanOrEqual(Math.min(...leftward) - 1.9);
      }
    });
  }

  it('control: plain-barline bars keep their chord x-positions', () => {
    const plain = chartToSvg(doc('C | F | G | C |'), { width: 720 }).svg;
    // Interior bars close on a plain `|`, so nothing about them may move.
    expect(inkStart(plain, 1, 0)).toBeCloseTo(cellOf(plain, 1).x + 8, 6);
    expect(inkStart(plain, 2, 0)).toBeCloseTo(cellOf(plain, 2).x + 8, 6);
  });

  it('the reservation shrinks the symbol rather than widening the cell', () => {
    // Cell widths stay uniform across the whole chart.
    const a = chartToSvg(doc('Cmaj7#11 | F | G | C |'), { width: 420 }).svg;
    const b = chartToSvg(doc('Cmaj7#11 | F | G | C :|]'), { width: 420 }).svg;
    expect(cellOf(b, 0).w).toBeCloseTo(cellOf(a, 0).w, 6);
    expect(cellOf(b, 3).w).toBeCloseTo(cellOf(a, 3).w, 6);
  });
});

describe('the `:||:` boundary carries the ink of both signs', () => {
  it('spans as wide as the two standalone glyphs and draws two thick rules', () => {
    const both = chartToSvg(doc('C | F :||: G | C |]'), { width: 720 }).svg;
    const bar1 = cellOf(both, 1);
    const boundary = bar1.x + bar1.w;
    const near = repeatDotXs(both).filter((d) => Math.abs(d - boundary) < 20);
    expect(near.length).toBe(4); // two closing dots + two opening dots
    expect(Math.min(...near)).toBeCloseTo(boundary - 12, 1);
    expect(Math.max(...near)).toBeCloseTo(boundary + 12, 1);
    // Two heavy rules, as an end-then-begin boundary carries in engraving.
    const thicks = attrs(both, /class="cc-barline cc-barline--thick"[^>]*x="([\d.-]+)"/g)
      .map(Number)
      .filter((tx) => Math.abs(tx - boundary) < 20);
    expect(thicks.length).toBe(2);
  });

  it('a LINE-boundary repeatBoth still starts the next line with a plain `|`', () => {
    // `drawnLeadingKinds` is the one place the line-start fixup happens, and
    // the widened `:||:` glyph must not reach it.
    const kinds = drawnLeadingKinds([
      { leadingBarline: 'repeatBoth' },
      { leadingBarline: 'repeatBoth' },
    ] as never);
    expect(kinds[0]).toBe('repeatOpen');
    expect(kinds[1]).toBe('repeatBoth');
    // A closing-type ornament at a line start flattens to a plain `|`.
    expect(drawnLeadingKinds([{ leadingBarline: 'repeatClose' }] as never)[0]).toBe('plain');
    expect(drawnLeadingKinds([{ leadingBarline: 'final' }] as never)[0]).toBe('plain');
  });
});

describe('a repeat start on a new line is drawn once', () => {
  it('draws `|:` only at the start of the next line, not also at the end of the previous one', () => {
    const svg = chartToSvg(doc('C | F | G | C |\n|: D | G :|'), { width: 720 }).svg;
    // One repeat start (2 dots) and one repeat end (2 dots).
    expect(repeatDotXs(svg).length).toBe(4);
  });

  it('keeps only the closing half of `:||:` at a line end', () => {
    const svg = chartToSvg(doc('|: C | F :|\n|: G | C :|'), { width: 720 }).svg;
    expect(repeatDotXs(svg).length).toBe(8);
  });

  it('drawnClosingKind flattens opening-type ornaments at a line end', () => {
    const end = (k: string) => drawnClosingKind([{ closingBarline: k }] as never);
    expect(end('repeatOpen')).toBe('plain');
    expect(end('repeatBoth')).toBe('repeatClose');
    expect(end('repeatClose')).toBe('repeatClose');
    expect(end('final')).toBe('final');
    expect(end('plain')).toBe('plain');
  });
});
