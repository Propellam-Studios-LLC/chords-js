/**
 * Chord-chart rendering — for chord charts, what abcjs does for notation. The
 * library owns the chart the way abcjs owns the staff:
 *
 *   `chartModel(form, opts)`               → the chart MODEL (sections → lines → bars)
 *   `chartSvg(model, opts)`                → deterministic, DOM-free SVG (see chartSvg.ts)
 *   `chartToSvg(text | form, opts)`        → both, in one call, no DOM needed
 *   `renderChart(element, text, opts)`     → parse + render into a DOM element
 *   `renderChartFromForm(element, form, …)`→ the same from a stored `form`
 *
 * The chart's conventions are iReal Pro's, not a text dump of the file:
 *
 * - **Duration is never text — it is the onset.** A chord's `units` becomes its
 *   share of the bar cell, and each chord is LEFT-JUSTIFIED at the point that
 *   share starts: `Ebmaj7/2 Cm7/2` reads at the bar line and the half-bar
 *   point, a 2/3 + 1/3 bar at 0 and 2/3. No `/2` reaches the page.
 * - **Symbols are typeset**, not printed: a large root with the quality set
 *   smaller beside it, real ♭/♯ glyphs, and (in shorthand notation) the iReal
 *   Pro `△` / `ø` / `°` / `-` vocabulary with stacked alterations.
 * - **Bar cells are equal-width across the whole chart**, honouring the
 *   author's own line breaks. A chord symbol is NEVER truncated: one that does
 *   not fit its slot is scaled down instead.
 *
 * Works straight from the structure-preserving `Form` (no realizer), so it
 * renders even progressions the realizer can't yet draw (e.g. voltas).
 */

import { displaySuffixFor } from './chordSymbol.js';
import {
  NO_CHORD_PARTS,
  qualityFor,
  symbolText,
  toGlyphs,
  type ChartMode,
  type SymbolNotation,
  type SymbolParts,
} from './chartSymbolGlyphs.js';
import { chartSvg, type ChartSvgOptions } from './chartSvg.js';
import { parse, parseStructure, type Form, type FormChord } from './parse.js';
import { PART_RE, repeatBrackets, type BarlineToken, type FinalBarline } from './parseBody.js';
import { transposeFormToKey } from './transpose.js';

export type { ChartMode, SymbolNotation, SymbolParts };

/** Bars per line when the form has no authored line indices to wrap on. */
const DEFAULT_BARS_PER_LINE = 4;

/** One chord slot inside a bar. */
export interface ChartChord {
  /** Plain-text label with real accidental glyphs and NO duration suffix. */
  label: string;
  /** The same symbol decomposed for typesetting. */
  parts: SymbolParts;
  /** Duration in `L:` units, as written. */
  units: number;
  /** This chord's share of the bar (`units / Σunits`). */
  weight: number;
  /** Cumulative share of the bar before this chord (0 for the first). */
  offset: number;
  /** Slot index within the bar, in written order. */
  index: number;
}

/** One bar in the chart model. */
export interface ChartBar {
  /** Flat index in the chart's WRITTEN bar order — the index every host id,
   * overlay and active-slot tint is keyed on. */
  index: number;
  /** Measure number as printed (`%%setbarnb` shifts it). */
  number: number;
  /** One label per chord — a convenience mirror of `chords[].label`. */
  symbols: string[];
  chords: ChartChord[];
  /** Opens a repeat (`|:`) on its leading barline. */
  openRepeat: boolean;
  /** Closes a repeat (`:|`) on its trailing barline. */
  closeRepeat: boolean;
  /** The barline drawn before this bar. */
  leadingBarline: BarlineToken;
  /** The barline drawn after this bar (the next bar's leading, or the final). */
  closingBarline: BarlineToken | FinalBarline;
  /** 1st/2nd-ending number, or null. */
  volta: number | null;
  /** The `P:` section this bar belongs to, or null. */
  part: string | null;
  /** Pass-through text annotations (`"…"`, `!…!`, D.C./D.S., segno/coda). */
  annotations: string[];
  /** 0-based authored line index. */
  line: number;
}

/** A row of bars (the chart wraps on authored lines, or every `barsPerLine`). */
export interface ChartLine {
  /** Authored line index (or the synthetic one, when wrapping by count). */
  index: number;
  bars: ChartBar[];
}

/** A run of consecutive lines under one `P:` label. */
export interface ChartSection {
  part: string | null;
  lines: ChartLine[];
}

/** The chart model returned by {@link chartModel}. */
export interface ChordChart {
  mode: ChartMode;
  notation: SymbolNotation;
  barsPerLine: number;
  /** Every line, flattened — the pre-section view, kept for hosts that only
   * want rows. */
  lines: ChartLine[];
  sections: ChartSection[];
  barCount: number;
  /** Print a measure number every N bars (`%%barnumbers N`), or null. */
  barNumbers: number | null;
  title: string | null;
  composer: string | null;
  key: string | null;
  meter: string | null;
}

/** Options for {@link chartModel} and the render entry points. */
export interface RenderChartOptions {
  /** Label each chord with absolute symbols (`letters`, default) or Roman
   * degrees (`roman`). */
  mode?: ChartMode;
  /** iReal-Pro `shorthand` (default) or `classical` quality spelling. Ignored
   * in Roman mode, which always renders classically. */
  notation?: SymbolNotation;
  /** Letters mode only: re-spell in this key from each chord's stored `degree`.
   * Null/omitted = the form's canonical roots. Ignored in Roman mode. */
  transposeKey?: string;
  /** Bars per line (default 4). */
  barsPerLine?: number;
  /** Wrap on the author's own line breaks (each bar's `line` index) instead of a
   * fixed [barsPerLine]. Falls back to [barsPerLine] when any bar lacks `line`
   * (e.g. a hand-built or pre-`line` form). Defaults to on. */
  groupByLine?: boolean;
  /** Group lines into `P:` sections (default true). */
  groupBySection?: boolean;
  /** `P:` label per authored chord line — supplied by {@link renderChart} from
   * the `.chords` text, or by a host that stores section labels alongside a
   * `form` (a bare `Form` carries none). See {@link partsByChordLine}. */
  partsByLine?: (string | null)[];
  /** Write the governing chord into every empty bar it lasts through. */
  spellHeldBars?: boolean;
  /** Print a measure number every N bars. `renderChart` reads `%%barnumbers`
   * from the document; this overrides it. */
  barNumbers?: number | null;
  /** The number of the first bar (`%%setbarnb`), default 1. */
  firstBarNumber?: number;
  /** Header text for the model's metadata fields (filled in from the document
   * by the text entry points). */
  title?: string | null;
  composer?: string | null;
  key?: string | null;
  meter?: string | null;
}

// --------------------------------------------------------------------------- //
// Symbols
// --------------------------------------------------------------------------- //

/** Roman-degree symbol (e.g. `ii7`, `V7/I`, `i/2`, or `N.C.`). The degree's case
 * already conveys minor, so a leading `m` is dropped from the suffix.
 *
 * Exported because it is the reference output this library's Roman *parser*
 * is tested against: parsing what this renders must reproduce the same degree
 * and canonical type, for every chord type in the vocabulary. There is no
 * external reference for Roman input, so the renderer is the reference — and a
 * test that reimplemented it would pin nothing.
 *
 * It keeps its duration suffix (`i/2`) — that is what the parser round-trips.
 * The chart calls it with `units: 1`, which is the only way to get the bare
 * symbol: stripping the suffix by regex cannot tell a duration `/2` from a
 * slash-bass degree `/2`. */
export function romanSymbol(c: FormChord): string {
  if (c.noChord) return 'N.C.';
  const degree = c.degree ?? '?';
  const type = c.type ?? '';
  const suffix = displaySuffixFor(type);
  const shown = type.startsWith('min') ? suffix.replace(/^m/, '') : suffix;
  return `${degree}${shown}${c.bassDegree ? `/${c.bassDegree}` : ''}${durationSuffix(c.units)}`;
}

/** The `.chords` duration suffix for a chord that occupies [units] of a bar.
 * A whole bar (`1`) has none; a whole number of bars `n` → `n`; `1/N` →
 * `/N`; other clean rationals → `num/den`. A value that isn't a clean small
 * fraction gets no suffix. */
function durationSuffix(units: number): string {
  if (Math.abs(units - 1) < 1e-9) return '';
  if (units > 1 && Math.abs(units - Math.round(units)) < 1e-9) {
    return `${Math.round(units)}`;
  }
  for (let den = 2; den <= 16; den++) {
    const num = units * den;
    if (Math.abs(num - Math.round(num)) < 1e-6) {
      const n = Math.round(num);
      return n === 1 ? `/${den}` : `${n}/${den}`;
    }
  }
  return '';
}

/** Typesetting parts for one form chord, in the requested vocabulary/notation. */
function partsFor(
  c: FormChord,
  mode: ChartMode,
  notation: SymbolNotation,
): SymbolParts {
  if (c.noChord) return { ...NO_CHORD_PARTS };
  if (mode === 'roman') {
    // Roman is always classical: the degree's case already carries quality.
    const type = c.type ?? '';
    const suffix = displaySuffixFor(type);
    const shown = type.startsWith('min') ? suffix.replace(/^m/, '') : suffix;
    return {
      root: toGlyphs(c.degree ?? '?'),
      quality: toGlyphs(shown),
      alterations: [],
      bass: c.bassDegree ? toGlyphs(c.bassDegree) : null,
    };
  }
  const { quality, alterations } = qualityFor(c.type ?? 'maj', notation);
  return {
    root: toGlyphs(c.root ?? '?'),
    quality,
    alterations,
    bass: c.bass ? toGlyphs(c.bass) : null,
  };
}

// --------------------------------------------------------------------------- //
// The model
// --------------------------------------------------------------------------- //

/**
 * Build the chart model from a `Form`. In `letters` mode with a [transposeKey],
 * the roots are re-spelled into that key first (via {@link transposeFormToKey}).
 */
export function chartModel(form: Form, opts: RenderChartOptions = {}): ChordChart {
  const mode = opts.mode ?? 'letters';
  // Roman ALWAYS renders classically (the degree's case already carries the
  // quality), so the model reports what it actually drew rather than echoing a
  // request it ignored.
  const notation: SymbolNotation =
    mode === 'roman' ? 'classical' : (opts.notation ?? 'shorthand');
  const barsPerLine = opts.barsPerLine ?? DEFAULT_BARS_PER_LINE;
  const firstBarNumber = opts.firstBarNumber ?? 1;
  const src =
    mode === 'letters' && opts.transposeKey
      ? transposeFormToKey(form, opts.transposeKey)
      : form;

  // Repeat brackets are derived from the faithful per-bar barline model; the
  // chart draws them but the model itself never interprets repeats.
  const brackets = repeatBrackets(src.bars, src.finalBarline);
  const leadingOf = (i: number): BarlineToken | FinalBarline => {
    if (i >= src.bars.length) return src.finalBarline;
    return src.bars[i].leadingBarline ?? (i === 0 ? 'none' : 'plain');
  };

  const useAuthoredLines =
    (opts.groupByLine ?? true) &&
    form.bars.every((b) => typeof b.line === 'number');
  const partsByLine = opts.partsByLine ?? [];

  const bars: ChartBar[] = src.bars.map((bar, i) => {
    const line = useAuthoredLines
      ? (form.bars[i].line as number)
      : Math.floor(i / barsPerLine);
    const total = bar.chords.reduce((n, c) => n + (c.units || 0), 0) || 1;
    let offset = 0;
    const chords: ChartChord[] = bar.chords.map((c, j) => {
      const weight = (c.units || 0) / total;
      const parts = partsFor(c, mode, notation);
      const chord: ChartChord = {
        label: symbolText(parts),
        parts,
        units: c.units,
        weight,
        offset,
        index: j,
      };
      offset += weight;
      return chord;
    });
    return {
      index: i,
      number: firstBarNumber + i,
      symbols: chords.map((c) => c.label),
      chords,
      openRepeat: brackets[i].open,
      closeRepeat: brackets[i].close,
      leadingBarline: (src.bars[i].leadingBarline ??
        (i === 0 ? 'none' : 'plain')) as BarlineToken,
      closingBarline: leadingOf(i + 1),
      volta: bar.volta ?? null,
      part: useAuthoredLines ? (partsByLine[line] ?? null) : null,
      annotations: bar.annotations ?? [],
      line,
    };
  });

  if (opts.spellHeldBars) spellHeldBarsIn(bars);

  // Group into lines, then lines into sections.
  const lines: ChartLine[] = [];
  for (const bar of bars) {
    let line = lines[lines.length - 1];
    if (!line || line.index !== bar.line) {
      line = { index: bar.line, bars: [] };
      lines.push(line);
    }
    line.bars.push(bar);
  }

  const sections: ChartSection[] = [];
  if (opts.groupBySection ?? true) {
    for (const line of lines) {
      const part = line.bars[0]?.part ?? null;
      let section = sections[sections.length - 1];
      if (!section || section.part !== part) {
        section = { part, lines: [] };
        sections.push(section);
      }
      section.lines.push(line);
    }
  } else {
    sections.push({ part: null, lines });
  }

  return {
    mode,
    notation,
    barsPerLine,
    lines,
    sections,
    barCount: bars.length,
    barNumbers: opts.barNumbers ?? null,
    title: opts.title ?? null,
    composer: opts.composer ?? null,
    key: opts.key ?? null,
    meter: opts.meter ?? null,
  };
}

/**
 * Write the governing chord into every empty bar it lasts through. Mutates in
 * place — the bars were built by {@link chartModel}, not supplied by a caller.
 */
function spellHeldBarsIn(bars: ChartBar[]): void {
  let governing: ChartChord | null = null;
  for (const bar of bars) {
    if (bar.chords.length > 0) {
      governing = bar.chords[bar.chords.length - 1];
    } else if (governing) {
      const held: ChartChord = { ...governing, weight: 1, offset: 0, index: 0 };
      bar.chords = [held];
      bar.symbols = [held.label];
    }
    // Nothing has sounded yet — there is no governing chord to write.
  }
}

/**
 * `P:` label for each *chord* body line, by index.
 *
 * `FormBar.line` counts only the lines that carry bars — `P:` markers are body
 * lines too but are not counted — so the mapping has to be rebuilt with the
 * same rule rather than read off `bodyLines` positions.
 */
export function partsByChordLine(text: string): (string | null)[] {
  const { bodyLines } = parseStructure(text);
  const parts: (string | null)[] = [];
  let current: string | null = null;
  for (const line of bodyLines) {
    const m = PART_RE.exec(line);
    if (m) {
      current = m[1].trim();
      continue;
    }
    parts.push(current);
  }
  return parts;
}

/** Build the chart model straight from `.chords` text: section labels, the
 * header metadata and the `%%barnumbers` / `%%setbarnb` directives all come
 * from the document. */
export function chartModelFromText(
  text: string,
  opts: RenderChartOptions = {},
): { chart: ChordChart; errors: string[] } {
  const parsed = parse(text);
  const barnb = parsed.directives['barnumbers'];
  const setbarnb = parsed.directives['setbarnb'];
  const fromDirective = barnb !== undefined ? parseInt(barnb, 10) : NaN;
  const firstFromDirective = setbarnb !== undefined ? parseInt(setbarnb, 10) : NaN;
  const chart = chartModel(parsed.form, {
    partsByLine: partsByChordLine(text),
    barNumbers: Number.isFinite(fromDirective) && fromDirective > 0
      ? fromDirective
      : null,
    firstBarNumber: Number.isFinite(firstFromDirective) ? firstFromDirective : 1,
    title: parsed.title ?? null,
    composer: parsed.composer ?? null,
    key: parsed.headers.K ?? null,
    meter: parsed.headers.M ?? null,
    ...opts,
  });
  return { chart, errors: parsed.errors };
}

// --------------------------------------------------------------------------- //
// Entry points (abcjs parity)
// --------------------------------------------------------------------------- //

/** Options accepted by the render entry points. */
export type ChartRenderOptions = RenderChartOptions & ChartSvgOptions;

/** What the render entry points hand back. */
export interface ChartRender {
  svg: string;
  model: ChordChart;
  width: number;
  height: number;
  /** The element rendered into (absent for the DOM-free {@link chartToSvg}). */
  element?: Element;
}

/** Stable id for a bar group — never string-build one by hand. */
export function chartBarId(bar: number): string {
  return `cc-bar-${bar}`;
}

/** Stable id for a chord slot — never string-build one by hand. */
export function chartChordId(bar: number, slot: number): string {
  return `cc-chord-${bar}-${slot}`;
}

/**
 * Render `.chords` text (or a `Form`) to an SVG string. No DOM required, and
 * byte-identical in Node and the browser, so its output can be compared
 * against stored reference SVGs.
 *
 * @param source `.chords` text (header directives and `P:` labels are read
 *   from it), or an already-parsed `Form`.
 * @param options Model options and SVG layout options, in one object.
 * @returns The SVG, the model it was drawn from, and the SVG's pixel size.
 *   Parse errors in `source` are not thrown; use {@link chartModelFromText}
 *   to see them.
 *
 * @example
 * const { svg, height } = chartToSvg(chordsText, { width: 600 });
 */
export function chartToSvg(
  source: string | Form,
  options: ChartRenderOptions = {},
): ChartRender {
  const model =
    typeof source === 'string'
      ? chartModelFromText(source, options).chart
      : chartModel(source, options);
  const { svg, width, height } = chartSvg(model, options);
  return { svg, model, width, height };
}

/**
 * Fit the chart to the element it is being rendered into, when the caller did
 * not state a width.
 *
 * `chartSvg`'s 720 px default is a sensible *document* width and a bad guess at
 * a *container*: in a narrower host (a 358 px phone screen, say) the last bars
 * of every row would fall off the edge. The DOM entry points know the real
 * answer, so they ask the element for its `clientWidth`.
 *
 * Deliberately only here: {@link chartToSvg} stays DOM-free and deterministic,
 * so its output is reproducible. An element that has not been laid
 * out yet reports 0 — treat that as "no answer" and keep the default rather
 * than engraving a zero-width chart.
 */
function fitToElement(el: Element, options: ChartRenderOptions): ChartRenderOptions {
  if (options.width != null) return options;
  const measured = (el as HTMLElement).clientWidth || 0;
  if (!(measured > 0)) return options;
  return { ...options, width: measured };
}

function resolveElement(target: string | Element, fn: string): Element {
  if (typeof target !== 'string') return target;
  const doc = (globalThis as { document?: Document }).document;
  let el: Element | null = doc?.getElementById(target) ?? null;
  if (!el && doc) {
    try {
      el = doc.querySelector(target);
    } catch {
      el = null; // not a valid selector (e.g. '1st-chart'): report "not found" below
    }
  }
  if (!el) {
    throw new Error(`${fn}: target '${target}' not found (a DOM is required).`);
  }
  return el;
}

/**
 * Render a `.chords` document into a DOM element, abcjs-style
 * (`renderChart("paper", chordsText, {…})` beside abcjs's
 * `renderAbc(element, abcString, params)`). Replaces the element's contents.
 *
 * @param element The target element, or its id / a CSS selector.
 * @param chordsText The `.chords` document.
 * @param options Model and SVG options; `width` defaults to the element's
 *   `clientWidth` when it has been laid out.
 * @returns What {@link chartToSvg} returns, plus the element rendered into.
 * @throws Error if [element] is a string that matches no element, or there is
 *   no DOM.
 *
 * @example
 * renderChart('paper', chordsText, { mode: 'roman' }); // Roman degrees
 */
export function renderChart(
  element: string | Element,
  chordsText: string,
  options: ChartRenderOptions = {},
): ChartRender {
  const el = resolveElement(element, 'renderChart');
  const rendered = chartToSvg(chordsText, fitToElement(el, options));
  el.innerHTML = rendered.svg;
  return { ...rendered, element: el };
}

/**
 * The same, from a stored `form` — the shape a host that never sees `.chords`
 * text holds (e.g. a form saved in a database). Section labels only if
 * `options.partsByLine` is supplied, since a stored form carries none.
 *
 * @param element The target element, or its id / a CSS selector.
 * @param form The parsed chord form.
 * @param options Model and SVG options; `width` defaults to the element's
 *   `clientWidth` when it has been laid out.
 * @returns What {@link chartToSvg} returns, plus the element rendered into.
 * @throws Error if [element] is a string that matches no element, or there is
 *   no DOM.
 */
export function renderChartFromForm(
  element: string | Element,
  form: Form,
  options: ChartRenderOptions = {},
): ChartRender {
  const el = resolveElement(element, 'renderChartFromForm');
  const rendered = chartToSvg(form, fitToElement(el, options));
  el.innerHTML = rendered.svg;
  return { ...rendered, element: el };
}
