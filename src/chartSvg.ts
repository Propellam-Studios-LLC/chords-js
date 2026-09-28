/**
 * The canonical chord-chart renderer: a chart model → an SVG string.
 *
 * **DOM-free and deterministic.** Nothing here measures text through a browser
 * (`getBBox`, `measureText`); every width comes from `chartMetrics`'s advance
 * table and every position is arithmetic. So Node and the browser emit the same
 * bytes, which is what makes the reference outputs in `test/chartSvg.test.ts`
 * possible and what lets a chart be rendered with no browser at all.
 *
 * **Nothing is ever truncated**: a chord symbol that does not fit its slot is
 * scaled down, that one symbol only — never cut off with an ellipsis. There is
 * no `text-overflow` in this renderer and no `…` in its output.
 *
 * **Everything is addressable.** Stable ids (`cc-bar-{bar}`,
 * `cc-chord-{bar}-{slot}`, in written bar order), `data-` attributes, and a
 * documented state-class vocabulary a host toggles without re-rendering:
 * `is-correct` · `is-wrong` · `is-missed` · `is-active` · `is-active-row` ·
 * `is-dim` · `is-selected`. Colours come from `--cc-*` CSS variables, so a host
 * restyles (dark mode, Flutter theme colours, a scoring overlay) without
 * touching the SVG.
 *
 * `is-selected` is the *selection* vocabulary, deliberately a different colour
 * from `is-active`: "this slot is playing" and "this slot is the one being
 * edited" are two different states, and a UI may show both at once.
 */

import { advanceWidth } from './chartMetrics.js';
import type { SymbolParts, SymbolNotation } from './chartSymbolGlyphs.js';
import type { ChartBar, ChartChord, ChartLine, ChordChart } from './chart.js';

/** Layout/appearance knobs for {@link chartSvg}. */
export interface ChartSvgOptions {
  /** Overall SVG width in px (default 720). */
  width?: number;
  /** Height of a bar cell in px (default 56). */
  barHeight?: number;
  /** Root-glyph font size in px (default 19). */
  rootFontSize?: number;
  /** Font stack for the chart (default a system sans stack). */
  fontFamily?: string;
  /** Outer padding in px (default 12). */
  padding?: number;
  /** Render the `T:`/`C:` headers above the chart (default false — hosts
   * usually have their own title bar). */
  showTitle?: boolean;
  /** Print each line's number in a left gutter (default false).
   *
   * The number is 1-based and **absolute to the chart** — `line.index + 1`,
   * never the position within a cropped window — and it is emitted INSIDE its
   * own `<g class="cc-line">` group, so a host that hides or crops lines to
   * show a rolling window takes each number with its row, and a window over
   * lines 1–2 correctly reads "2, 3". */
  rowNumbers?: boolean;
  /** Embed {@link chartCss} as the SVG's first child (default true), so one
   * inline `<svg>` is self-contained in a browser, a WebView and a saved file. */
  embedCss?: boolean;
  /** Per-slot annotation text, indexed `[barIndex][slotIndex]` in WRITTEN bar
   * order — the same index the ids and state classes use. A non-null cell is
   * drawn in parentheses under that chord's symbol, inside its `cc-chord`
   * group, so a state class colours the annotation with the symbol.
   *
   * Intended for scoring feedback: beside the *correct* symbol, in
   * parentheses, what the user actually entered. It is NOT
   * `ChartBar.annotations`, which is the document's own pass-through text
   * (D.C., segno, `"…"`).
   *
   * @example
   * // Bar 0, slot 1 was answered "Dm7":
   * chartSvg(chart, { entryAnnotations: [[null, 'Dm7']] }); */
  entryAnnotations?: (string | null)[][];
}

const DEFAULT_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Minimum a bar cell may be, before widening. */
const MIN_CELL = 46;
/** Breathing room either side of a chord symbol inside its slot. */
const SLOT_GAP = 8;

/**
 * How far a drawn barline's ink reaches either side of its nominal `x`.
 *
 * **Stated ONCE, here, beside the `switch` in `barline()` that draws it**, and
 * must be kept in step with it. Both sides matter: `chordIndent` uses the
 * rightward reach so a bar's first chord clears an opening repeat, and
 * `chordRoom` uses the leftward reach so a bar's last chord clears a closing
 * repeat (a `repeatClose` draws its dots ~11.9px to the LEFT of its nominal x).
 *
 * Reaches are the outermost ink of each glyph: a `dots(dx)` circle has
 * `r = 1.9`, a `thick(lx)` rect is 3.2 wide, a `line(lx)` path is ~1 wide.
 */
function barlineInkReach(kind: string): { left: number; right: number } {
  switch (kind) {
    case 'repeatOpen':
      return { left: 0, right: 11.9 }; // dots(x + 10) + r
    case 'repeatClose':
      return { left: 11.9, right: 0 }; // dots(x - 10) + r
    case 'repeatBoth':
      return { left: 13.9, right: 13.9 }; // dots(x ∓ 12) + r
    case 'final':
      return { left: 4.5, right: 0 }; // line(x - 4), half-width
    default:
      return { left: 0, right: 0 };
  }
}

/** Space after a root that carries a quality, as a fraction of the root size. */
const ROOT_GAP = 0.04;
/** Space before a slash bass, as a fraction of the bass size. */
const BASS_GAP = 0.08;
/** Left gutter reserved for row numbers when `rowNumbers` is on. */
const ROW_NUM_GUTTER = 22;
/** Vertical gap between chart lines. */
const LINE_GAP = 8;
/** Strip above a line reserved for voltas / bar numbers. */
const TOP_STRIP = 15;
/** Height of a `P:` section label block. */
const PART_BLOCK = 22;
/** The smallest scale a symbol is shrunk to when it overruns its slot. A floor
 * on the shrink, so a very long symbol in a very narrow slot stays legible. */
const MIN_SYMBOL_SCALE = 0.45;

const round = (n: number): number => Math.round(n * 100) / 100;

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --------------------------------------------------------------------------- //
// Symbol typesetting
// --------------------------------------------------------------------------- //

interface GlyphPiece {
  cls: string;
  text: string;
  /** x offset from the symbol's left edge, in px. */
  dx: number;
  /** baseline offset from the symbol's baseline, in px (negative = raised). */
  dy: number;
  size: number;
}

interface SymbolLayout {
  width: number;
  pieces: GlyphPiece[];
}

/**
 * Lay a symbol out as absolutely positioned pieces: a large root, the quality
 * set smaller and raised beside it, alterations smaller still and stacked in a
 * column, and the slash bass on the main baseline.
 *
 * Absolute positions (rather than `dy`-chained tspans) because we already know
 * every advance width — and because chained `dy` is relative to each tspan's own
 * font-size, which is exactly the kind of implicit measurement this renderer
 * refuses to depend on.
 */
export function layoutSymbol(
  parts: SymbolParts,
  rootSize: number,
  notation: SymbolNotation = 'classical',
): SymbolLayout {
  // Shorthand quality glyphs (△ ø ° - + and the shorthand 7 / 9 / 13 suffixes)
  // are the iReal-Pro look: set nearly as large as the root and dropped to a
  // SUBSCRIPT, not shrunk into a small superscript. Classical spellings
  // ('maj7', 'm7♭5') stay small and raised beside the root.
  const shorthand = notation === 'shorthand';
  const qualSize = rootSize * (shorthand ? 0.82 : 0.62);
  const qualDy = shorthand ? rootSize * 0.08 : -rootSize * 0.34;
  const altSize = rootSize * (shorthand ? 0.62 : 0.5);
  // Shorthand sets the WHOLE qualifier stack as one subscript run: '7♯9'
  // reads as three characters on one dropped baseline, not as a low '7'
  // beside a raised '♯9'. Classical keeps the small raised column
  // — there the alterations are the ♭5 / ♯9 that ride above a plain '7'.
  const altBaseDy = shorthand ? qualDy : -rootSize * 0.34;
  const bassSize = rootSize * 0.78;
  const pieces: GlyphPiece[] = [];
  let x = 0;

  const rootW = advanceWidth(parts.root, rootSize);
  pieces.push({ cls: 'cc-root', text: parts.root, dx: 0, dy: 0, size: rootSize });
  x += rootW;
  // A hairline after the root: a bold round letter's ink can overhang its advance.
  if (parts.quality || parts.alterations.length > 0) x += rootSize * ROOT_GAP;

  if (parts.quality) {
    const w = advanceWidth(parts.quality, qualSize);
    pieces.push({
      cls: 'cc-qual',
      text: parts.quality,
      dx: x,
      dy: qualDy,
      size: qualSize,
    });
    x += w;
  }

  if (parts.alterations.length > 0) {
    const k = parts.alterations.length;
    let colW = 0;
    parts.alterations.forEach((alt, i) => {
      const w = advanceWidth(alt, altSize);
      if (w > colW) colW = w;
      pieces.push({
        cls: 'cc-alt',
        text: alt,
        dx: x,
        // Stacked upwards: the last alteration sits on the quality's line.
        dy: altBaseDy - (k - 1 - i) * rootSize * 0.52,
        size: altSize,
      });
    });
    x += colW;
  }

  if (parts.bass) {
    // A small gap before the slash, so a quality's last glyph never touches it.
    if (x > 0) x += bassSize * BASS_GAP;
    const text = `/${parts.bass}`;
    const w = advanceWidth(text, bassSize);
    pieces.push({ cls: 'cc-bass', text, dx: x, dy: 0, size: bassSize });
    x += w;
  }

  return { width: x, pieces };
}

/** Estimated width of a symbol at [rootSize] in the given [notation]. */
export function symbolWidth(
  parts: SymbolParts,
  rootSize: number,
  notation: SymbolNotation = 'classical',
): number {
  return layoutSymbol(parts, rootSize, notation).width;
}

// --------------------------------------------------------------------------- //
// Line geometry — the no-truncation invariant lives here
// --------------------------------------------------------------------------- //

/**
 * The barline kind actually DRAWN at each bar's left edge in a line.
 *
 * This is NOT `bar.leadingBarline`: the barline between the previous line's
 * last bar and this line's first was already drawn as *that* line's closing
 * barline, so a closing-type ornament is flattened at a line start (and a
 * `repeatBoth` keeps only its opening half). One function computes it because
 * two things read the answer — the barline loop that draws it, and the chord
 * indent, which must never indent past an ornament that was never drawn.
 */
export function drawnLeadingKinds(bars: ChartBar[]): string[] {
  return bars.map((bar, i) => {
    let kind: string = bar.leadingBarline === 'none' ? 'plain' : bar.leadingBarline;
    if (i === 0) {
      if (kind === 'repeatClose' || kind === 'final') kind = 'plain';
      else if (kind === 'repeatBoth') kind = 'repeatOpen';
    }
    return kind;
  });
}

/**
 * The barline kind actually DRAWN at a line's right edge.
 *
 * The mirror of [drawnLeadingKinds]: when the next bar starts a new line, an
 * opening-type ornament belongs to that line's start, where it is drawn. So at
 * a line end a `repeatOpen` flattens to a plain `|` and a `repeatBoth` keeps
 * only its closing half. Otherwise `A | B |` + `|: C` would draw `|:` twice,
 * once at each end of the line break.
 */
export function drawnClosingKind(bars: ChartBar[]): string {
  const kind: string = bars[bars.length - 1].closingBarline;
  if (kind === 'repeatOpen') return 'plain';
  if (kind === 'repeatBoth') return 'repeatClose';
  return kind;
}

/**
 * How far the first chord of bar [barIndex] is pushed right so it clears its
 * left barline's ink. Zero for a plain or end-only barline, whose rightward
 * reach is zero, and for every chord but the bar's first.
 *
 * The indent is the drawn glyph's own reach ({@link barlineInkReach}), so a
 * `repeatBoth` (wider than a `repeatOpen`) gets the clearance it actually needs
 * and a `repeatOpen` is not pushed further than its own dots require.
 */
function chordIndent(chord: ChartChord, barIndex: number, kinds: string[]): number {
  return chord.index === 0
    ? barlineInkReach(kinds[barIndex] ?? 'plain').right
    : 0;
}

/**
 * Where a chord's ink starts inside its bar cell.
 *
 * **Every chord is LEFT-JUSTIFIED at its own onset** — `cellX + cellW *
 * chord.offset`, where `offset` is the cumulative share of the bar written
 * before it. The `.chords` duration fractions (`/2`, `/3`, `/4`) therefore
 * decide the geometry by themselves and no meter is consulted: a `C/2 G/2` bar
 * reads at the bar line and the half-bar point, a `C/3 F/3 G/3` bar at the
 * thirds, a `C/4 F/2 G/4` bar at 0, ¼ and ¾. A lone unfractioned chord has
 * `offset === 0`, so it is simply left-justified in its bar, with no special
 * case.
 */
function chordStartX(
  cellX: number,
  cellW: number,
  chord: ChartChord,
  indent: number,
): number {
  return cellX + cellW * chord.offset + SLOT_GAP + indent;
}

/**
 * The horizontal room a chord's ink may occupy: its own share of the cell, less
 * the breathing gap and any repeat indent. Because justification is at the
 * onset, this is exactly the distance to where the NEXT chord starts.
 *
 * For the bar's LAST chord it also clears the CLOSING barline's own ink:
 * `SLOT_GAP` alone, measured from the barline's nominal x, is ~3.9px short of a
 * `repeatClose`'s dots and ~1.9px short of a `repeatBoth`'s, so without this
 * the symbol and the repeat dots would intersect. `closingKind` is the barline
 * drawn at the bar's right edge — the next bar's leading kind, or the line's
 * closing kind for the last bar of a line.
 */
function chordRoom(
  cellW: number,
  chord: ChartChord,
  barIndex: number,
  kinds: string[],
  isLastChord: boolean,
  closingKind: string,
): number {
  const closingClearance = isLastChord ? barlineInkReach(closingKind).left : 0;
  return (
    cellW * Math.max(chord.weight, 0.05) -
    SLOT_GAP -
    chordIndent(chord, barIndex, kinds) -
    closingClearance
  );
}

/**
 * Split a line's available width between its bars.
 *
 * **Cells are uniform ACROSS THE WHOLE CHART** — every bar is one grid column,
 * `avail / gridCols`, where `gridCols` is the chart's widest row, so every
 * measure has the same width however many measures its line holds. A row
 * holding fewer bars occupies its first `n` columns and leaves the rest of the
 * row empty — it is never stretched and never centred.
 *
 * `gridCols` defaults to the row's own length (the row's bars share `avail`
 * equally), so a caller that does not know the chart still gets a sane row.
 *
 * Nothing is scaled here. Shrinking is per SYMBOL, done by the drawing loop:
 * each chord that overruns its own slot scales only itself down. A symbol that
 * fits renders at full size however crowded its neighbours are, so one
 * crowded bar never shrinks the rest of its row.
 */
export function allocateLine(
  bars: ChartBar[],
  avail: number,
  gridCols?: number,
): { widths: number[] } {
  const n = bars.length;
  if (n === 0) return { widths: [] };
  const cols = Math.max(gridCols ?? n, n);
  return { widths: new Array<number>(n).fill(avail / cols) };
}

/**
 * The number of grid columns the whole chart is laid out on: its widest row,
 * never fewer than `barsPerLine`, and never fewer than 1.
 *
 * Authored lines may exceed `barsPerLine`, so taking the max over the rendered
 * lines as well is what keeps every row inside the frame.
 */
export function gridColumns(chart: ChordChart): number {
  let cols = chart.barsPerLine;
  for (const section of chart.sections) {
    for (const line of section.lines) {
      if (line.bars.length > cols) cols = line.bars.length;
    }
  }
  return Math.max(cols, 1);
}

/**
 * How many grid columns a line is indented so a volta ending sits under the
 * ending before it.
 *
 * Returns 0 unless this line OPENS with a volta numbered above 1 and the line
 * before it carries a lower-numbered ending. The indent is that earlier
 * ending's own absolute column — its position within its line PLUS whatever
 * that line was itself indented by — so a third ending lands in the same
 * column as the second rather than staircasing further right.
 *
 * Alignment is best-effort: equal-length endings then align
 * measure-for-measure by construction, and unequal ones still start at the
 * same column. The caller drops the indent entirely when the line would not
 * fit — cells are never shrunk to force it.
 */
export function voltaIndentCols(
  prev: { line: ChartLine; indent: number } | null,
  line: ChartLine,
): number {
  const opening = line.bars[0]?.volta;
  if (prev == null || opening == null || opening <= 1) return 0;
  const earlier = voltaRuns(prev.line)
    .filter((r) => r.volta < opening)
    .sort((a, b) => a.volta - b.volta)[0];
  if (earlier == null) return 0;
  return prev.indent + earlier.from;
}

// --------------------------------------------------------------------------- //
// Drawing
// --------------------------------------------------------------------------- //

/** ABC decoration shorthands the chart draws as real music glyphs. */
const NAV_GLYPH: Record<string, { glyph: string; kind: string }> = {
  S: { glyph: '\u{1d10b}', kind: 'segno' },
  O: { glyph: '\u{1d10c}', kind: 'coda' },
  segno: { glyph: '\u{1d10b}', kind: 'segno' },
  coda: { glyph: '\u{1d10c}', kind: 'coda' },
};

function annotationParts(a: string): { text: string; kind: string } {
  const hit = NAV_GLYPH[a];
  if (hit) return { text: hit.glyph, kind: hit.kind };
  if (/^D\.?C\.?$/i.test(a)) return { text: a, kind: 'dc' };
  if (/^D\.?S\.?$/i.test(a)) return { text: a, kind: 'ds' };
  return { text: a, kind: 'text' };
}

/** Draw one barline of [kind] at [x], from [top] to [bottom], returning its
 * SVG. [before] and [after] are the indices of the bars either side (null at a
 * line edge), emitted as `data-before-bar` / `data-after-bar`. */
function barline(
  kind: string,
  x: number,
  top: number,
  bottom: number,
  before: number | null,
  after: number | null,
): string {
  const out: string[] = [];
  const attrs = (extra: string) =>
    `${before != null ? ` data-before-bar="${before}"` : ''}` +
    `${after != null ? ` data-after-bar="${after}"` : ''}${extra}`;
  const line = (lx: number, cls: string) =>
    `<path class="cc-barline cc-barline--${cls}"${attrs('')} d="M${round(lx)} ${round(top)}V${round(bottom)}"/>`;
  const thick = (lx: number) =>
    `<rect class="cc-barline cc-barline--thick"${attrs('')} x="${round(lx)}" y="${round(top)}" width="3.2" height="${round(bottom - top)}"/>`;
  const dots = (dx: number) =>
    [0.38, 0.62]
      .map(
        (f) =>
          `<circle class="cc-repeat-dot" cx="${round(dx)}" cy="${round(top + (bottom - top) * f)}" r="1.9"/>`,
      )
      .join('');

  switch (kind) {
    case 'repeatOpen':
      out.push(thick(x), line(x + 5, 'repeatOpen'), dots(x + 10));
      break;
    case 'repeatClose':
      out.push(dots(x - 10), line(x - 5, 'repeatClose'), thick(x - 3.2));
      break;
    case 'repeatBoth':
      // An end-then-begin boundary carries the ink of BOTH signs: two thick
      // rules, with dot insets matching the standalone glyphs' reach, so it
      // reads with the same weight as the two signs drawn separately.
      // `barlineInkReach('repeatBoth')` states the resulting span and must be
      // kept in step with these numbers.
      out.push(
        dots(x - 12),
        line(x - 7, 'repeatBoth'),
        thick(x - 5.2),
        thick(x + 2),
        line(x + 7, 'repeatBoth'),
        dots(x + 12),
      );
      break;
    case 'final':
      out.push(line(x - 4, 'final'), thick(x - 3.2));
      break;
    default:
      out.push(line(x, 'plain'));
  }
  return out.join('');
}

/** Runs of consecutive bars in a line that share one volta number. */
function voltaRuns(line: ChartLine): { volta: number; from: number; to: number }[] {
  const runs: { volta: number; from: number; to: number }[] = [];
  line.bars.forEach((bar, i) => {
    if (bar.volta == null) return;
    const last = runs[runs.length - 1];
    if (last && last.volta === bar.volta && last.to === i - 1) {
      last.to = i;
    } else {
      runs.push({ volta: bar.volta, from: i, to: i });
    }
  });
  return runs;
}

/**
 * Render a chart model to SVG. Pure — no DOM, no measurement, same bytes
 * everywhere.
 *
 * @param chart The chart model, from `chartModel` or `chartModelFromText`.
 * @param opts Layout and appearance options; every field is optional.
 * @returns The SVG markup and its pixel size. `width` is the requested width
 *   (720 when omitted or not a positive number); `height` follows from the
 *   number of lines.
 *
 * @example
 * const { svg } = chartSvg(chartModel(form), { width: 480 });
 * container.innerHTML = svg;
 */
export function chartSvg(
  chart: ChordChart,
  opts: ChartSvgOptions = {},
): { svg: string; width: number; height: number } {
  const width = typeof opts.width === 'number' && Number.isFinite(opts.width) && opts.width > 0
    ? opts.width
    : 720;
  const barHeight = opts.barHeight ?? 56;
  const rootSize = opts.rootFontSize ?? 19;
  const padding = opts.padding ?? 12;
  const fontFamily = opts.fontFamily ?? DEFAULT_FONT;
  const embedCss = opts.embedCss ?? true;
  const entryAnnotations = opts.entryAnnotations;
  const rowNumbers = opts.rowNumbers ?? false;
  const gutter = rowNumbers ? ROW_NUM_GUTTER : 0;
  const avail = Math.max(width - 2 * padding - gutter, MIN_CELL);
  // One grid for the whole chart: a cell is avail/gridCols
  // whatever its row holds, so a two-bar row's measures are as wide as a
  // four-bar row's.
  const gridCols = gridColumns(chart);
  const gridCellW = avail / gridCols;
  // The previously RENDERED line and the indent it was drawn at, tracked
  // chart-wide rather than per section: a second ending sometimes opens a new
  // part box, and the volta-number guard in `voltaIndentCols` is what makes a
  // cross-section look-back safe.
  let prevLine: { line: ChartLine; indent: number } | null = null;

  const body: string[] = [];
  let y = padding;

  if (opts.showTitle && (chart.title || chart.composer)) {
    if (chart.title) {
      y += 20;
      body.push(
        `<text class="cc-title" x="${round(width / 2)}" y="${round(y)}" text-anchor="middle">${esc(chart.title)}</text>`,
      );
    }
    if (chart.composer) {
      y += 14;
      body.push(
        `<text class="cc-composer" x="${round(width / 2)}" y="${round(y)}" text-anchor="middle">${esc(chart.composer)}</text>`,
      );
    }
    y += 8;
  }

  for (const section of chart.sections) {
    const sectionAttr = section.part != null ? ` data-section="${esc(section.part)}"` : '';
    const parts: string[] = [`<g class="cc-section"${sectionAttr}>`];

    if (section.part) {
      const labelW = advanceWidth(section.part, 11) + 14;
      parts.push(
        `<rect class="cc-part-box" x="${round(padding)}" y="${round(y)}" width="${round(labelW)}" height="16" rx="3"/>`,
        `<text class="cc-part"${sectionAttr} x="${round(padding + 7)}" y="${round(y + 12)}">${esc(section.part)}</text>`,
      );
      y += PART_BLOCK;
    }

    for (const line of section.lines) {
      const runs = voltaRuns(line);
      const numbered =
        chart.barNumbers != null &&
        line.bars.some((b) => b.number % (chart.barNumbers as number) === 0);
      const strip = runs.length > 0 || numbered ? TOP_STRIP : 0;
      const top = y + strip;
      const bottom = top + barHeight;
      const baseline = top + barHeight * 0.62;

      const { widths } = allocateLine(line.bars, avail, gridCols);
      // Volta alignment, best-effort: dropped outright when the indented row
      // would not fit; cells are never shrunk for it.
      const wanted = voltaIndentCols(prevLine, line);
      const indentCols =
        wanted + line.bars.length > gridCols ? 0 : wanted;
      // Every symbol starts at full size; only one that overruns its own slot
      // shrinks, and only itself.
      const lineRoot = rootSize;

      parts.push(
        `<g class="cc-line" data-line="${line.index}" data-first-bar="${line.bars[0]?.index ?? 0}">`,
      );

      // The row's own number, in the left gutter and INSIDE this line's group,
      // so a host cropping to a rolling window carries the number with its
      // row, and the ABSOLUTE index is what prints.
      if (rowNumbers) {
        parts.push(
          `<text class="cc-rownum" x="${round(padding + gutter - 6)}" y="${round(baseline)}" text-anchor="end">${line.index + 1}</text>`,
        );
      }

      // Cell boundaries.
      const xs: number[] = [padding + gutter + indentCols * gridCellW];
      for (const w of widths) xs.push(xs[xs.length - 1] + w);

      // Barlines: this bar's leading, plus the closing one at the line's end.
      // One source for what is actually drawn (including the line-start
      // flattening), so the chord indent below cannot disagree with the
      // ornament.
      const leadingKinds = drawnLeadingKinds(line.bars);
      // The barline drawn at each bar's RIGHT edge — the next bar's leading
      // kind, and for the line's last bar the line's own closing kind. This is
      // what `chordRoom` needs to clear the closing barline's ink.
      const closingKind = drawnClosingKind(line.bars);
      const closingKinds = line.bars.map((_, i) =>
        i < line.bars.length - 1
          ? leadingKinds[i + 1]
          : closingKind,
      );
      line.bars.forEach((bar, i) => {
        parts.push(
          barline(
            leadingKinds[i],
            xs[i],
            top,
            bottom,
            i > 0 ? line.bars[i - 1].index : null,
            bar.index,
          ),
        );
      });
      const lastBar = line.bars[line.bars.length - 1];
      parts.push(
        barline(closingKind, xs[xs.length - 1], top, bottom, lastBar.index, null),
      );

      // Bars.
      line.bars.forEach((bar, i) => {
        const cellX = xs[i];
        const cellW = widths[i];
        const partAttr = bar.part != null ? ` data-section="${esc(bar.part)}"` : '';
        parts.push(
          `<g class="cc-bar" id="cc-bar-${bar.index}" data-bar="${bar.index}" data-line="${line.index}" data-measure="${bar.number}"${partAttr}>`,
          `<rect class="cc-bar-hit" x="${round(cellX)}" y="${round(top)}" width="${round(cellW)}" height="${round(barHeight)}" fill="transparent"/>`,
        );

        if (
          chart.barNumbers != null &&
          bar.number % (chart.barNumbers as number) === 0
        ) {
          parts.push(
            `<text class="cc-barnum" x="${round(cellX + 3)}" y="${round(top - 4)}">${bar.number}</text>`,
          );
        }

        for (const annot of bar.annotations) {
          const { text, kind } = annotationParts(annot);
          parts.push(
            `<text class="cc-annot cc-nav cc-nav--${kind}" x="${round(cellX + cellW - 4)}" y="${round(top + 12)}" text-anchor="end">${esc(text)}</text>`,
          );
        }

        for (const chord of bar.chords) {
          const slotX = cellX + cellW * chord.offset;
          const slotW = cellW * chord.weight;
          const indent = chordIndent(chord, i, leadingKinds);
          let size = lineRoot;
          let laid = layoutSymbol(chord.parts, size, chart.notation);
          const room = chordRoom(
            cellW,
            chord,
            i,
            leadingKinds,
            chord.index === bar.chords.length - 1,
            closingKinds[i] ?? 'plain',
          );
          if (laid.width > room && room > 0) {
            // In-bounds scale-down — never an ellipsis, and the ONLY shrink
            // there is: it moves this symbol alone, so a long chord in a
            // crowded measure never drags its row down with it.
            const ratio = Math.max(room / laid.width, MIN_SYMBOL_SCALE);
            size = size * ratio;
            laid = layoutSymbol(chord.parts, size, chart.notation);
          }
          // EVERY chord is left-justified at its own onset — see
          // `chordStartX`. Nothing here consults a meter: the written duration
          // fractions already say where each chord falls in the bar.
          const startX = chordStartX(cellX, cellW, chord, indent);
          const glyphs = laid.pieces
            .map(
              (p) =>
                `<tspan class="${p.cls}" x="${round(startX + p.dx)}" y="${round(baseline + p.dy)}" font-size="${round(p.size)}">${esc(p.text)}</tspan>`,
            )
            .join('');
          const entry =
            entryAnnotations?.[bar.index]?.[chord.index] ?? null;
          // Under the symbol, inside the slot and inside the bar cell — the
          // baseline sits at 62% of the bar height, which leaves room for an
          // 11px line without growing the row or crossing the barline.
          const entryText =
            entry == null
              ? ''
              : `<text class="cc-annot-entry" x="${round(slotX + slotW / 2)}" y="${round(bottom - 5)}" text-anchor="middle">(${esc(entry)})</text>`;
          parts.push(
            `<g class="cc-chord" id="cc-chord-${bar.index}-${chord.index}" data-bar="${bar.index}" data-slot="${chord.index}" data-units="${chord.units}" data-label="${esc(chord.label)}">`,
            // A transparent per-slot hit rect, the slot-level twin of
            // `cc-bar-hit`. Chord groups are emitted AFTER the bar rect, so a
            // tap inside a bar that has chords resolves to the SLOT, and a tap
            // in an empty bar falls through to the bar — which is exactly the
            // hit semantics a UI that edits individual slots needs.
            `<rect class="cc-slot-hit" x="${round(slotX)}" y="${round(top)}" width="${round(slotW)}" height="${round(barHeight)}" fill="transparent"/>`,
            `<text class="cc-sym">${glyphs}</text>`,
            entryText,
            '</g>',
          );
        }
        parts.push('</g>');
      });

      // Voltas, in the strip above the row.
      for (const run of runs) {
        const x0 = xs[run.from] + 2;
        const x1 = xs[run.to + 1] - 2;
        const ty = top - 4;
        const closes =
          line.bars[run.to].closeRepeat || run.to === line.bars.length - 1;
        const d =
          `M${round(x0)} ${round(ty + 9)}V${round(ty)}H${round(x1)}` +
          (closes ? `V${round(ty + 9)}` : '');
        parts.push(
          `<g class="cc-volta" data-volta="${run.volta}" data-from-bar="${line.bars[run.from].index}" data-to-bar="${line.bars[run.to].index}">`,
          `<path class="cc-volta-bracket" d="${d}"/>`,
          `<text class="cc-volta-num" x="${round(x0 + 4)}" y="${round(ty + 8)}">${run.volta}.</text>`,
          '</g>',
        );
      }

      parts.push('</g>');
      prevLine = { line, indent: indentCols };
      y = bottom + LINE_GAP;
    }

    parts.push('</g>');
    body.push(parts.join(''));
  }

  const height = Math.round(y + padding);
  const style = embedCss ? `<style>${chartCss}</style>` : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" class="cc-chart cc-chart--${chart.mode} cc-chart--${chart.notation}"` +
    ` viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"` +
    ` font-family="${esc(fontFamily)}" data-bars="${chart.barCount}" data-lines="${chart.lines.length}"` +
    ` data-mode="${chart.mode}" data-notation="${chart.notation}">` +
    `${style}${body.join('')}</svg>`;
  return { svg, width, height };
}

/**
 * The default stylesheet, driven entirely by `--cc-*` CSS variables so a host
 * restyles without touching the SVG. Embedded in the SVG by default.
 *
 * Custom properties DO cascade into inline SVG; they do NOT reach an
 * `<img src="data:…">`. The renderer's contract is therefore "inline this SVG".
 */
export const chartCss = `
.cc-chart {
  --cc-ink: #1a1a1a; --cc-muted: #7a8288; --cc-line: #444a4f; --cc-bg: transparent;
  --cc-part: #2c3e50; --cc-part-bg: #eef2f5; --cc-volta: #c0392b; --cc-annot: #8e44ad;
  --cc-correct: #1e8e3e; --cc-wrong: #c62828; --cc-missed: #ef6c00;
  --cc-active-tint: #e8f0fe; --cc-active-ink: #1558d6;
  --cc-selected-tint: #d7e3ff; --cc-selected-line: #1558d6;
  background: var(--cc-bg);
}
.cc-sym { fill: var(--cc-ink); font-weight: 700; }
.cc-qual, .cc-alt { font-weight: 600; }
.cc-bass { font-weight: 600; }
.cc-barline { stroke: var(--cc-line); stroke-width: 1.2; fill: none; }
.cc-barline--thick { fill: var(--cc-line); stroke: none; }
.cc-repeat-dot { fill: var(--cc-line); }
.cc-part { fill: var(--cc-part); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.cc-part-box { fill: var(--cc-part-bg); }
.cc-volta-bracket { stroke: var(--cc-volta); stroke-width: 1.2; fill: none; }
.cc-volta-num { fill: var(--cc-volta); font-size: 9px; font-weight: 700; }
.cc-barnum { fill: var(--cc-muted); font-size: 9px; }
.cc-rownum { fill: var(--cc-muted); font-size: 11px; font-weight: 700; }
.cc-annot { fill: var(--cc-annot); font-size: 11px; }
.cc-title { fill: var(--cc-ink); font-size: 15px; font-weight: 700; }
.cc-composer { fill: var(--cc-muted); font-size: 11px; }
.cc-chord.is-correct .cc-sym { fill: var(--cc-correct); }
.cc-chord.is-wrong .cc-sym { fill: var(--cc-wrong); }
.cc-chord.is-missed .cc-sym { fill: var(--cc-missed); }
.cc-chord.is-active .cc-sym { fill: var(--cc-active-ink); }
.cc-bar.is-active .cc-bar-hit, .cc-line.is-active-row .cc-bar-hit { fill: var(--cc-active-tint); }
.cc-chord.is-dim .cc-sym, .cc-bar.is-dim .cc-sym { opacity: .4; }
.cc-annot-entry { fill: var(--cc-ink); font-size: 11px; font-style: italic; }
.cc-chord.is-correct .cc-annot-entry { fill: var(--cc-correct); }
.cc-chord.is-wrong .cc-annot-entry { fill: var(--cc-wrong); }
.cc-chord.is-missed .cc-annot-entry { fill: var(--cc-missed); }
.cc-bar.is-selected .cc-bar-hit, .cc-chord.is-selected .cc-slot-hit {
  fill: var(--cc-selected-tint); stroke: var(--cc-selected-line); stroke-width: 1.5;
}
@media (prefers-color-scheme: dark) {
  .cc-chart {
    --cc-ink: #e8eaed; --cc-muted: #9aa0a6; --cc-line: #9aa0a6;
    --cc-part: #cfd8dc; --cc-part-bg: #2a2f34; --cc-volta: #ef9a9a; --cc-annot: #ce93d8;
    --cc-correct: #81c995; --cc-wrong: #f28b82; --cc-missed: #fcad70;
    --cc-active-tint: #253046; --cc-active-ink: #8ab4f8;
    --cc-selected-tint: #31405c; --cc-selected-line: #8ab4f8;
  }
}
`.trim();
