/**
 * Realizes chord progressions into playable ABC notation. The reference outputs
 * in `test/golden/` pin the exact ABC produced, so changes to it are deliberate.
 *
 * Each chord (absolute root + canonical type + optional slash bass) becomes a
 * written-out "boom-chick" comping span — the bass root low, the full chord
 * stack mid-register, one stroke per comping beat — with the chord symbol shown
 * above the staff. The beat is the meter's own pulse: a quarter in simple
 * meters, a dotted quarter in 6/8 / 9/8 / 12/8 (see {@link boomChick}).
 * Pitches carry explicit accidentals only when they differ from what is
 * already sounding (key signature, then any accidental earlier in the
 * bar), matching abcjs's per-bar accidental carry; spelling favours the chord's
 * own root letter (so `Bb6` is B-D-F-G, never A#…).
 *
 * Two entry points:
 *   - **`realizeChords(text)`** — the faithful translator: `.chords` source →
 *     ABC, preserving the author's line breaks, `P:` part markers, 1st/2nd-ending
 *     voltas, and quoted annotations. Use this when you have the source file.
 *   - **`realizeForm(form)`** — a stored structure `form` (snake_case `DbForm`) →
 *     ABC, wrapped every `barsPerLine` bars (for playback of a stored form,
 *     where there is no source layout to preserve). Map `parse()`'s camelCase
 *     `Form` with `formToDbForm`.
 *
 * Both share the spelling + comping core; comping is pluggable (see
 * {@link compingPatterns}).
 */

import { annotationToAbc } from './annotations.js';
import { chordSymbol } from './chordSymbol.js';
import { loadVocabulary } from './chordTypes.js';
import { parseKey } from './key.js';
import { isCompoundMeter, meterNumDen } from './meter.js';
import { parse, parseStructure } from './parse.js';
import type { Form } from './parse.js';
import { isNoChord, parseChordToken } from './parseChord.js';
import {
  BODY_TOKEN_RE,
  BarlineToken,
  FinalBarline,
  PART_RE,
  classifyToken,
} from './parseBody.js';

// --------------------------------------------------------------------------- //
// DB (snake_case) form shape — the realizer's input contract
// --------------------------------------------------------------------------- //

/** One chord in the DB `form` (snake_case; absolute root incl. accidental). */
export interface DbFormChord {
  root?: string;
  /** Canonical type, e.g. `min7`; absent/ignored for a no-chord. */
  type?: string | null;
  bass?: string | null;
  /** Duration in `L:`-units. */
  units: number;
  no_chord?: boolean;
}

export interface DbFormBar {
  volta?: number | null;
  chords: DbFormChord[];
  /** The barline that opens this bar (`plain`/`repeatOpen`/`repeatClose`/
   * `repeatBoth`/`none`) — the faithful, per-bar repeat/section structure. Emitted
   * verbatim into ABC; abcjs interprets it. Optional (`plain`/`none` default). */
  leading_barline?: BarlineToken;
  /** Pass-through annotations carried on this bar — quoted text, `!…!`
   * decorations, the D.C./D.S. marks, and the bare `S`/`O` segno/coda
   * shorthands. Emitted inside the bar by {@link realizeFormBody} via
   * {@link annotationToAbc}; a host that stores the form must round-trip this
   * field, or the author's decorations are lost when the form is saved. */
  annotations?: string[];
}

export interface DbForm {
  bars: DbFormBar[];
  /** The barline closing the progression: `final` (`|]`) or `repeatClose`. */
  final_barline?: FinalBarline;
}

/** Options for {@link realizeForm}. */
export interface RealizeOptions {
  /** Notation/canonical key, e.g. `Gm`. */
  key: string;
  /** Meter, e.g. `4/4`. */
  timeSignature: string;
  title?: string;
  composer?: string;
  /** `Q:` tempo string; default `1/4=120`. */
  tempo?: string;
  /** Break to a new ABC line every N bars (0 disables wrapping). */
  barsPerLine?: number;
  /**
   * How each chord's span is "played"/arranged into ABC. Defaults to
   * {@link boomChick}. Pass a built-in from {@link compingPatterns} or a custom
   * {@link CompingPattern}.
   */
  comping?: CompingPattern;
}

/**
 * The per-chord context a {@link CompingPattern} arranges into ABC. The shared
 * realizer core has already done the hard part — spelling the chord tones + bass
 * in the key (favouring the chord's own letters) — so a pattern only decides
 * *rhythm/voicing*: which of these notes sound, when, and for how long.
 *
 * Render notes via [renderNote] (never hand-build pitch strings) so per-bar
 * accidental carry stays correct: it emits an accidental only when it differs
 * from what is already sounding for that (letter, octave) in the bar, and
 * mutating that state is order-sensitive — call [renderNote] left-to-right in
 * emission order.
 */
export interface CompingContext {
  /** Spelled chord tones, low → high (mid register). */
  tones: Note[];
  /** Spelled bass note (slash bass or root, one octave below the stack). */
  bassNote: Note;
  /** This chord's span, in quarter-note (`L:1/4`) units. */
  quarters: Frac;
  /**
   * The length of one comping beat in quarter-note units — a quarter in simple
   * meters, a dotted quarter in 6/8 / 9/8 / 12/8. Patterns must step by
   * this, not by whole quarters, or they fight the compound pulse.
   */
  beatQuarters: Frac;
  /**
   * 1-based starting **quarter-note** position of this chord within the bar —
   * despite the name this is not a beat index, and in a compound meter it does
   * not count beats at all (a 6/8 bar's second dotted beat is `beat === 2.5`).
   * Meter-aware patterns should read [barOffsetQuarters] instead.
   */
  beat: number;
  /** This chord's onset within the bar, in quarter-note units (0 = the barline). */
  barOffsetQuarters: Frac;
  /** Beats in the full measure (quarter-note units). */
  measureQuarters: Frac;
  /** Spell one note to an ABC pitch token, threading per-bar accidental carry. */
  renderNote(note: Note): string;
  /** ABC length suffix for a [frac]-quarter duration (e.g. `2`, `/2`, `3/2`). */
  abcLength(frac: Frac): string;
}

/**
 * A comping strategy: given one chord's spelled tones + duration + beat/meter
 * context, emit the ABC tokens for that span. See {@link compingPatterns} for
 * the built-ins and {@link boomChick} for the default.
 */
export type CompingPattern = (ctx: CompingContext) => string;

export class RealizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealizeError';
  }
}

/**
 * Map the camelCase {@link Form} from `parse()` to the snake_case
 * {@link DbForm} that {@link realizeForm} consumes. Keeps each bar's volta,
 * leading barline, and annotations; drops the Roman-degree and beat fields.
 */
export function formToDbForm(form: Form): DbForm {
  return {
    final_barline: form.finalBarline,
    bars: form.bars.map((b) => ({
      volta: b.volta,
      leading_barline: b.leadingBarline,
      // Carried, not dropped: the parse recognizes S / O / !…! / D.C.-family
      // tokens, and without them a stored progression would render with none
      // of the author's decorations.
      ...(b.annotations && b.annotations.length > 0
        ? { annotations: [...b.annotations] }
        : {}),
      chords: b.chords.map((c) => {
        const out: DbFormChord = { units: c.units };
        if (c.noChord) {
          out.no_chord = true;
        } else {
          if (c.root !== undefined) out.root = c.root;
          out.type = c.type;
          if (c.bass !== undefined) out.bass = c.bass;
        }
        return out;
      }),
    })),
  };
}

// --------------------------------------------------------------------------- //
// Public API
// --------------------------------------------------------------------------- //

/**
 * Realize a stored DB `form` into a full ABC tune string ready for abcjs. The
 * caller supplies the notation key + meter (and optional metadata) via [opts].
 * For `.chords` source text, use {@link realizeChords}, which preserves the
 * author's layout/parts/voltas/annotations.
 *
 * Throws {@link RealizeError} if `opts.key` or `opts.timeSignature` is missing,
 * or if a chord has an unknown type; an unparseable `opts.key` also throws.
 *
 * @example
 * const { form } = parse(text);
 * const abc = realizeForm(formToDbForm(form), { key: 'G', timeSignature: '3/4' });
 */
export function realizeForm(form: DbForm, opts: RealizeOptions): string {
  if (!opts || !opts.key || !opts.timeSignature) {
    throw new RealizeError('realizeForm: opts.key and opts.timeSignature are required.');
  }
  // Header values are single ABC lines: a newline in a title would inject lines.
  const one = (v: string) => String(v).replace(/[\r\n]+/g, ' ').trim();
  const head: string[] = ['X:1'];
  if (opts.title) head.push(`T:${one(opts.title)}`);
  if (opts.composer) head.push(`C:${one(opts.composer)}`);
  head.push(`M:${one(opts.timeSignature)}`);
  head.push('L:1/4');
  head.push(`Q:${one(opts.tempo ?? '1/4=120')}`);
  head.push(`K:${one(opts.key)}`);
  const body = realizeFormBody(form, opts);
  head.push(body);
  return `${head.join('\n')}\n`;
}

/**
 * Realize just the music body (one or more lines of `|`-separated bars), keeping
 * the written repeat structure. The caller supplies headers (see
 * {@link realizeForm}).
 */
export function realizeFormBody(form: DbForm, opts: RealizeOptions): string {
  const barsPerLine = opts.barsPerLine ?? 4;
  const comping = opts.comping ?? boomChick;
  const keysig = keySignature(opts.key);
  const measureQuarters = measureQuartersFor(opts.timeSignature);
  const beatQuarters = beatQuartersFor(opts.timeSignature);
  const bars = form.bars;
  // The barline that opens each bar, kept faithfully per bar (no interpretation).
  // abcjs interprets the emitted `|:`/`:|`/`::`/`[n` tokens, so multiple repeats
  // + voltas pass straight through to playback.
  const leadingAbc: Record<BarlineToken, string> = {
    none: '',
    plain: '|',
    repeatOpen: '|:',
    repeatClose: ':|',
    repeatBoth: '::',
  };
  const leadOf = (i: number): BarlineToken =>
    bars[i].leading_barline ?? (i === 0 ? 'none' : 'plain');

  // Walk the written bars, emitting each one's *leading* barline + any 1st/2nd-
  // ending bracket, then its realized content. A bar whose `volta` differs from
  // the previous bar's opens a `[n` bracket. We break to a new ABC line every
  // [barsPerLine] bars (abcjs treats a body newline as a new staff line); 0
  // disables wrapping.
  let buffer = '';
  let barCount = 0;
  for (let i = 0; i < bars.length; i++) {
    const volta = bars[i].volta ?? null;
    const prevVolta = i > 0 ? (bars[i - 1].volta ?? null) : null;
    const opensVolta = volta !== null && volta !== prevVolta;

    // Leading barline before this bar (empty for a `none` first bar).
    if (i === 0) {
      buffer += leadingAbc[leadOf(0)];
    } else if (leadOf(i) === 'repeatBoth') {
      // Render a back-to-back section seam as `:|` closing the current line + a
      // new line opening with `|:`, instead of a lone `::` — clearer in the
      // staff, and abcjs interprets the two forms identically.
      buffer += ' :|\n|:';
      barCount = 0; // this bar begins a fresh line
    } else {
      const lineBreak = barsPerLine > 0 && barCount % barsPerLine === 0;
      const barline = leadingAbc[leadOf(i)] || '|';
      buffer += ` ${barline}${lineBreak ? '\n' : ''}`;
    }

    const content = realizeBar(
      bars[i],
      keysig,
      measureQuarters,
      beatQuarters,
      comping,
    );
    // The bar's own annotations sit INSIDE the bar, before its content: an ABC
    // decoration attaches to the note that follows it, so emitting `!segno!`
    // after the leading barline is what puts the glyph on the bar's downbeat.
    // A text-annotation fallback is position-agnostic and rides along in the
    // same slot.
    const annots = (bars[i].annotations ?? [])
      .map(annotationToAbc)
      .join(' ');
    const sep = buffer.length === 0 || buffer.endsWith('\n') ? '' : ' ';
    buffer += `${sep}${opensVolta ? `[${volta} ` : ''}${annots ? `${annots} ` : ''}${content}`;
    barCount++;
  }
  // A section repeating to the end closes with `:|` as its terminal barline —
  // don't append a redundant `|]` after it. Otherwise the tune ends `|]`.
  if ((form.final_barline ?? 'final') === 'repeatClose') {
    return `${buffer.trim()} :|`;
  }
  return `${buffer.trim()} |]`;
}

/** Options for {@link realizeChords}. */
export interface RealizeChordsOptions {
  /** Default `Q:` tempo if the file has no `Q:` header (default `1/4=120`). */
  tempo?: string;
  /** Comping strategy (default {@link boomChick}). */
  comping?: CompingPattern;
}

/** ABC information fields: the single-letter fields A–Z except J and Y, plus
 * lowercase m/r/s/w. Header fields outside this set (e.g. `Y`, `AK`, `PIECE`) are `.chords`-specific, not emitted. */
const ABC_INFO_FIELDS = new Set([
  ...'ABCDEFGHIKLMNOPQRSTUVWXZ',
  ...'mrsw',
]);
/** Fields the renderer constructs itself (never passed through). */
const CONSTRUCTED_FIELDS = new Set(['X', 'T', 'C', 'M', 'L', 'K', 'Q']);

const LEADING_BAR_RE = /^(\|\]|\|\||\|:|:\||::|\|)\s*/;

/**
 * Realize a `.chords` source string into ABC, faithfully preserving the author's
 * line breaks, `P:` part markers, 1st/2nd-ending voltas, and quoted annotations.
 * Header fields that are valid ABC information fields (e.g. `O:`, `R:`) are
 * passed through; `.chords`-only headers are not. Throws {@link RealizeError}
 * if the source has parse errors or is missing `M:`/`L:`/`K:`.
 *
 * @example
 * realizeChords('%chords-1.0\nM:4/4\nL:1/1\nK:C\n| C | G7 |]');
 */
export function realizeChords(text: string, opts: RealizeChordsOptions = {}): string {
  const result = parse(text);
  if (result.errors.length > 0) {
    throw new RealizeError(result.errors.join('; '));
  }
  const { headers } = result;
  for (const field of ['M', 'L', 'K'] as const) {
    if (!headers[field]) throw new RealizeError(`Missing required header ${field}:.`);
  }
  const { bodyLines } = parseStructure(text);

  const comping = opts.comping ?? boomChick;
  const meter = headers.M;
  const key = headers.K;
  const keysig = keySignature(key);
  const tempo = headers.Q || opts.tempo || '1/4=120';

  // L: is the default chord duration as a fraction of a MEASURE; measureQuarters
  // converts a measure-relative duration to quarter-note (L:1/4) ABC lengths.
  const [lNum, lDen] = headers.L.split('/').map((x) => parseInt(x, 10));
  const lUnit = new Frac(lNum, lDen);
  const measureQuarters = measureQuartersFor(meter);
  const beatQuarters = beatQuartersFor(meter);

  type Entry = { kind: 'music' | 'part'; text: string };
  const entries: Entry[] = [];
  let state: Record<string, number> = {}; // accidentals; reset at every barline
  let barOffset = Frac.ZERO; // quarters elapsed in the current bar (for beat context)

  for (const line of bodyLines) {
    const part = PART_RE.exec(line);
    if (part) {
      entries.push({ kind: 'part', text: `P:${part[1].trim()}` });
      state = {};
      barOffset = Frac.ZERO;
      continue;
    }
    const out: string[] = [];
    // Where the CURRENT bar's content begins in [out]. A real ABC decoration
    // attaches to the note after it, so a `!segno!` authored at the END of a bar
    // (`| G S :|`) is hoisted to that bar's first note rather than left
    // stranded before the barline, where abcjs has nothing to attach it to.
    // Text annotations keep their authored position (the reference outputs
    // depend on it).
    let barContentStart = 0;
    for (const m of line.matchAll(BODY_TOKEN_RE)) {
      const tok = m[0];
      const { kind, value } = classifyToken(tok);
      if (kind === 'chord') {
        const pt = parseChordToken(tok);
        const q = Frac.fromNumber(pt.units).mul(lUnit).mul(measureQuarters);
        if (isNoChord(pt)) {
          out.push(`z${abcLength(q)}`); // a rest doesn't alter accidentals
        } else {
          out.push(`"${pt.symbol}"`);
          const chord: DbFormChord = {
            root: pt.root + pt.rootAcc,
            type: pt.canonical,
            bass: pt.bass !== null ? pt.bass + (pt.bassAcc ?? '') : null,
            units: pt.units,
          };
          out.push(
            comping({
              tones: chordNotes(chord),
              bassNote: bassNote(chord),
              quarters: q,
              beat: barOffset.num / barOffset.den + 1,
              barOffsetQuarters: barOffset,
              measureQuarters,
              beatQuarters,
              renderNote: (n) => renderNote(n, keysig, state),
              abcLength,
            }),
          );
        }
        barOffset = barOffset.add(q);
      } else if (kind === 'annotation') {
        // One mapping for both realizers: a recognized navigation mark becomes
        // a real abcjs decoration, everything else a text annotation above the
        // staff.
        const abc = annotationToAbc(value as string);
        if (abc.startsWith('!')) {
          out.splice(barContentStart, 0, abc);
          barContentStart++;
        } else {
          out.push(abc);
        }
      } else if (kind === 'volta') {
        // `|1` keeps its barline; `[1`/bare `1` are bracket-only.
        out.push(tok[0] === '|' ? `|[${value}` : `[${value}`);
        if (tok[0] === '|') {
          state = {};
          barOffset = Frac.ZERO;
          barContentStart = out.length;
        }
      } else {
        // bar / rstart / rend / rboth / final — already valid ABC barlines.
        out.push(tok);
        state = {};
        barOffset = Frac.ZERO;
        barContentStart = out.length;
      }
    }
    entries.push({ kind: 'music', text: out.join(' ') });
  }

  const folded = foldBoundaryBarlines(entries);
  const lines = folded.filter((e) => e.text).map((e) => e.text);

  const head: string[] = ['X:1'];
  if (headers.T) head.push(`T:${headers.T}`);
  if (headers.C) head.push(`C:${headers.C}`);
  // Pass through every other ABC information field verbatim, in author order
  // (e.g. O:, R:, S:, N:, …); skip constructed + non-ABC (.chords-specific) ones.
  for (const [field, val] of Object.entries(headers)) {
    if (CONSTRUCTED_FIELDS.has(field) || !ABC_INFO_FIELDS.has(field)) continue;
    head.push(`${field}:${val}`);
  }
  head.push(`M:${meter}`);
  head.push('L:1/4');
  head.push(`Q:${tempo}`);
  head.push(`K:${key}`);
  return `${[...head, ...lines].join('\n')}\n`;
}

/**
 * Keep music lines from starting with a barline (which abcjs reads as an empty
 * measure): fold a leading barline onto the end of the most recent *music* line
 * (skipping `P:` markers), collapsing a now-redundant plain `|`. With no earlier
 * music line, the leading barline is dropped (a start is an implicit barline).
 */
function foldBoundaryBarlines(
  entries: { kind: 'music' | 'part'; text: string }[],
): { kind: 'music' | 'part'; text: string }[] {
  const out: { kind: 'music' | 'part'; text: string }[] = [];
  for (const entry of entries) {
    let text = entry.text;
    if (entry.kind === 'music') {
      const m = LEADING_BAR_RE.exec(text);
      if (m) {
        let prev = -1;
        for (let j = out.length - 1; j >= 0; j--) {
          if (out[j].kind === 'music') {
            prev = j;
            break;
          }
        }
        if (prev !== -1) {
          let p = out[prev].text.replace(/\s+$/, '');
          if (
            p.endsWith('|') &&
            !/(:\||\|\]|\|\||\|:|::)$/.test(p)
          ) {
            p = p.slice(0, -1).replace(/\s+$/, '');
          }
          out[prev] = { kind: 'music', text: `${p} ${m[1]}`.replace(/\s+$/, '') };
          text = text.slice(m[0].length).replace(/^\s+/, '');
        } else {
          text = text.replace(LEADING_BAR_RE, '').replace(/^\s+/, '');
        }
      }
    }
    out.push({ kind: entry.kind, text });
  }
  return out;
}

/**
 * The pitch-class set (0–11) of a chord's tones — its root plus every interval
 * in the canonical [type]'s pattern, reduced mod 12. Octave-, voicing-, and
 * inversion-agnostic (a slash bass adds no new pitch class). Throws for an
 * unknown [type].
 */
export function chordTonePitchClasses(root: string, type: string): Set<number> {
  const pattern = intervalsFor(type);
  const [letter, acc] = parseNote(root);
  const rootPc = (((LETTER_PC[letter] + acc) % 12) + 12) % 12;
  const out = new Set<number>();
  for (const iv of pattern) {
    const meta = INTERVAL_META[iv];
    if (meta) out.add((((rootPc + meta[1]) % 12) + 12) % 12);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Bar / chord realization
// --------------------------------------------------------------------------- //

function realizeBar(
  bar: DbFormBar,
  keysig: Record<string, number>,
  measureQuarters: Frac,
  beatQuarters: Frac,
  comping: CompingPattern,
): string {
  const chords = bar.chords;
  // Bar-fill invariant (enforced by validation): the bar's chord units sum
  // to one full measure. So a chord's quarter span is (its units / bar total) *
  // measureQuarters — no need to know the L: header.
  let barUnits = Frac.ZERO;
  for (const c of chords) barUnits = barUnits.add(Frac.fromNumber(c.units));

  const state: Record<string, number> = {}; // (letter+octave) -> accidental, per bar
  const render = (note: Note): string => renderNote(note, keysig, state);
  const tokens: string[] = [];
  let offset = Frac.ZERO; // quarters elapsed in the bar before this chord
  for (const c of chords) {
    const units = Frac.fromNumber(c.units);
    const q = units.div(barUnits).mul(measureQuarters);
    if (c.no_chord === true) {
      tokens.push(`z${abcLength(q)}`); // a rest doesn't alter accidentals
      offset = offset.add(q);
      continue;
    }
    tokens.push(`"${symbolFor(c)}"`);
    tokens.push(
      comping({
        tones: chordNotes(c),
        bassNote: bassNote(c),
        quarters: q,
        beat: offset.num / offset.den + 1,
        barOffsetQuarters: offset,
        measureQuarters,
        beatQuarters,
        renderNote: render,
        abcLength,
      }),
    );
    offset = offset.add(q);
  }
  return tokens.join(' ');
}

/** The displayed chord symbol, matching how the `.chords` file wrote it. */
function symbolFor(c: DbFormChord): string {
  return chordSymbol(c.root as string, c.type as string, c.bass ?? null);
}

// --------------------------------------------------------------------------- //
// Built-in comping patterns
// --------------------------------------------------------------------------- //

/**
 * The number of whole comping beats in [q], or null when [q] is not a whole
 * multiple of the beat (or has fewer than [min] of them) — the off-grid case
 * every pattern renders as a single sustained stack.
 */
function beatCount(ctx: CompingContext, min = 1): number | null {
  const beats = ctx.quarters.div(ctx.beatQuarters);
  if (beats.den !== 1 || beats.num < min) return null;
  return beats.num;
}

const stackToken = (ctx: CompingContext): string =>
  `[${ctx.tones.map((n) => ctx.renderNote(n)).join('')}]`;

/**
 * The comping SCAFFOLD belongs to the METER, not to the chords: which slots of
 * the bar take the bass root ("boom"/"oom") and which take the chord stack
 * ("chuck"/"pah") is fixed by the time signature, and the chords sounding at
 * each slot decide only which NOTES fill it — never the rhythm.
 *
 * Returns the 0-based indices of the bar's beats that take the BASS, or `null`
 * when the bar does not divide into a whole number of beats (no grid to walk;
 * callers sustain instead). Rules:
 *
 * - **compound** (dotted beat: 6/8, 9/8, 12/8): **every** beat — each dotted
 *   quarter is its own long–short figure whose LONG is the root.
 * - **simple**: the bar's `n` beats group greedily in **twos with a residual
 *   THREE**, and each group starts with a bass. So 2/4 → `{0}`; 4/4 and 2/2
 *   → `{0, 2}` (boom-chuck-boom-chuck); 3/4 → `{0}` (oom-pah-pah); 5/4 →
 *   `{0, 2}` (2+3); 6/4 → `{0,2,4}`;
 *   7/4 → `{0, 2, 4}` (2+2+3).
 */
export function bassBeatIndices(
  measureQuarters: Frac,
  beatQuarters: Frac,
): Set<number> | null {
  const beats = measureQuarters.div(beatQuarters);
  if (beats.den !== 1 || beats.num < 1) return null;
  const n = beats.num;
  // Compound: every dotted beat leads with the root.
  if (beatQuarters.den !== 1) return new Set(Array.from({ length: n }, (_, i) => i));
  const out = new Set<number>();
  let i = 0;
  while (i < n) {
    out.add(i);
    i += n - i > 3 ? 2 : n - i; // twos until a final group of 2 or 3
  }
  return out;
}

/**
 * The default boom-chick, one stroke per comping beat — walked against the
 * **BAR's** beat grid, not the chord's own span.
 *
 * The scaffold is the meter's ({@link bassBeatIndices}); a chord only supplies
 * the notes for the slots it covers. So a 4/4 bar is boom-chuck-boom-chuck and a
 * 3/4 bar oom-pah-pah however many chords fill them: `| C/4 Dm/4 F/4 G/4 |`
 * comes out `C, [DFA] F, [GBd]` — a chord arriving on a chuck slot is a stack,
 * and only a chord sounding on a boom slot contributes its root.
 *
 * **Compound meters subdivide each dotted beat into a LONG–SHORT figure whose
 * long is the root**, so the expanded ABC reflects the comping/vamping pattern
 * rather than flattening it to one stroke per beat. So each
 * dotted quarter is `root(quarter) + stack(eighth)` — a 6/8 jig bar comes out
 * `C, [CEG]/2 C, [CEG]/2`, a 9/8 slip jig three of those, a 12/8 bar four — and
 * EVERY beat leads with its own root, so a chord arriving on beat 2 of a 6/8 bar
 * sounds its root there. A 3/8 bar, which the meter helpers deliberately count
 * as simple, is nonetheless felt as one dotted quarter and takes the same
 * figure (see `compingBeatFor`).
 *
 * Only WHOLE beats take the figure; a partial segment (an off-grid legacy
 * chord that covers part of a beat) still renders as one token.
 *
 * Two spans have no scaffold to walk and sustain as a single stack: a bar that
 * does not divide into whole beats, and a chord that lies entirely inside one
 * beat. A chord that *starts* off the grid leads with a short stack filling out
 * the beat it interrupted, then joins the grid. (The validator rejects off-grid
 * onsets, so only unvalidated input reaches that case.)
 */
export const boomChick: CompingPattern = (ctx) => {
  const beat = compingBeatFor(ctx);
  const bassBeats = bassBeatIndices(ctx.measureQuarters, beat);
  const sustain = (): string => `${stackToken(ctx)}${ctx.abcLength(ctx.quarters)}`;
  if (bassBeats === null) return sustain();
  const compound = beat.den !== 1; // a dotted beat: subdivide it

  const start = ctx.barOffsetQuarters;
  const end = start.add(ctx.quarters);
  // The first grid onset at or after this chord's start: k * beat.
  const startBeats = start.div(beat);
  let k = Math.ceil(startBeats.num / startBeats.den);
  const firstOnset = beat.mul(new Frac(k, 1));
  if (firstOnset.cmp(end) >= 0) return sustain(); // no beat begins inside the span

  // Emit strictly left to right — renderNote threads per-bar accidental carry.
  const parts: string[] = [];
  let cursor = start;
  if (firstOnset.cmp(start) > 0) {
    parts.push(`${stackToken(ctx)}${ctx.abcLength(firstOnset.sub(start))}`);
    cursor = firstOnset;
  }
  while (cursor.cmp(end) < 0) {
    const next = beat.mul(new Frac(k + 1, 1));
    const stop = next.cmp(end) < 0 ? next : end;
    const span = stop.sub(cursor);
    if (compound && span.cmp(beat) === 0) {
      parts.push(longShortFigure(ctx, beat));
    } else {
      const token = bassBeats.has(k) ? ctx.renderNote(ctx.bassNote) : stackToken(ctx);
      parts.push(`${token}${ctx.abcLength(span)}`);
    }
    cursor = stop;
    k++;
  }
  return parts.join(' ');
};

/**
 * The comping beat `boomChick` walks, which is the meter's own beat except in
 * **3/8**: `beatQuartersFor` deliberately counts 3/8 in eighths (see
 * {@link isCompoundMeter}), so its bar is one and a half quarter beats, with no
 * whole-beat grid to walk. But a 3/8 bar is felt as one dotted quarter, like a
 * beat of 6/8 or 9/8, so the whole bar becomes the beat here and takes the same
 * long–short figure. This affects comping only — validation still counts 3/8
 * in eighths.
 */
function compingBeatFor(ctx: CompingContext): Frac {
  const beats = ctx.measureQuarters.div(ctx.beatQuarters);
  const barIsOneDottedBeat = beats.num === 3 && beats.den === 2;
  return barIsOneDottedBeat ? ctx.measureQuarters : ctx.beatQuarters;
}

/**
 * One compound beat as the long–short figure used for compound meters: the
 * LONG (two thirds of the dotted beat — a quarter, in x/8 meters) is the
 * chord's root, the SHORT (the remaining third — an eighth) is the rest of the
 * chord as a stack. Exact `Frac` arithmetic, so
 * the two always total the beat.
 */
function longShortFigure(ctx: CompingContext, beat: Frac): string {
  const long = beat.mul(new Frac(2, 3));
  const short = beat.sub(long);
  return (
    `${ctx.renderNote(ctx.bassNote)}${ctx.abcLength(long)} ` +
    `${stackToken(ctx)}${ctx.abcLength(short)}`
  );
}

/** One held chord stack for the whole span. */
export const blockSustained: CompingPattern = (ctx) =>
  `${stackToken(ctx)}${ctx.abcLength(ctx.quarters)}`;

/** A chord stack struck on every beat (sustained when off-grid). */
export const blockPerBeat: CompingPattern = (ctx) => {
  const beats = beatCount(ctx);
  if (beats !== null) {
    const len = ctx.abcLength(ctx.beatQuarters);
    return Array.from({ length: beats }, () => `${stackToken(ctx)}${len}`).join(' ');
  }
  return `${stackToken(ctx)}${ctx.abcLength(ctx.quarters)}`;
};

/** The bass note only — on every beat (sustained when off-grid). */
export const bassOnly: CompingPattern = (ctx) => {
  const beats = beatCount(ctx, 2);
  if (beats !== null) {
    const len = ctx.abcLength(ctx.beatQuarters);
    return Array.from({ length: beats }, () =>
      `${ctx.renderNote(ctx.bassNote)}${len}`,
    ).join(' ');
  }
  return `${ctx.renderNote(ctx.bassNote)}${ctx.abcLength(ctx.quarters)}`;
};

/**
 * A rolling arpeggio — bass then the chord tones low → high, one per beat,
 * cycling to fill the span (sustained stack when off-grid).
 */
export const arpeggio: CompingPattern = (ctx) => {
  const beats = beatCount(ctx, 2);
  if (beats !== null) {
    const voices = [ctx.bassNote, ...ctx.tones];
    const len = ctx.abcLength(ctx.beatQuarters);
    const parts: string[] = [];
    for (let i = 0; i < beats; i++) {
      parts.push(`${ctx.renderNote(voices[i % voices.length])}${len}`);
    }
    return parts.join(' ');
  }
  return `${stackToken(ctx)}${ctx.abcLength(ctx.quarters)}`;
};

/** Short staccato chord stabs: a half-beat stack + a half-beat rest, per beat. */
export const stabs: CompingPattern = (ctx) => {
  const beats = beatCount(ctx);
  if (beats !== null) {
    // Half a beat sounding, half silent — so the stab shortens with the beat in
    // compound meters instead of staying a straight eighth.
    const half = ctx.abcLength(ctx.beatQuarters.div(new Frac(2, 1)));
    return Array.from(
      { length: beats },
      () => `${stackToken(ctx)}${half} z${half}`,
    ).join(' ');
  }
  return `${stackToken(ctx)}${ctx.abcLength(ctx.quarters)}`;
};

/** The built-in comping patterns, by name (`boomChick` is the default). */
export const compingPatterns = {
  boomChick,
  blockSustained,
  blockPerBeat,
  bassOnly,
  arpeggio,
  stabs,
} as const satisfies Record<string, CompingPattern>;

/** Name of a built-in {@link compingPatterns} entry. */
export type CompingPatternName = keyof typeof compingPatterns;

/** Spelled chord tones (mid register), low → high, as the chord's stack. */
function chordNotes(c: DbFormChord): Note[] {
  const pattern = intervalsFor(c.type as string);
  const [letter, acc] = parseNote(c.root as string);
  const notes: Note[] = [];
  for (const iv of pattern) {
    if (INTERVAL_META[iv]) notes.push(spell(letter, acc, iv, 4));
  }
  notes.sort((a, b) => a.midi - b.midi);
  return notes;
}

/** Bass note (slash bass if present, else root) one octave below the stack. */
function bassNote(c: DbFormChord): Note {
  const [letter, acc] = parseNote((c.bass ?? c.root) as string);
  return spell(letter, acc, '1', 3);
}

// --------------------------------------------------------------------------- //
// Pitch helpers
// --------------------------------------------------------------------------- //

/** A spelled note: letter, octave (4 = the C-major middle octave), accidental
 * in [-6,5], and absolute MIDI number. */
export interface Note {
  letter: string;
  octave: number;
  acc: number;
  midi: number;
}

/** Spell an interval [label] above a root. The letter comes from the diatonic
 * degree (preserving the root's spelling); the accidental is whatever makes that
 * letter land on the target pitch. */
function spell(
  rootLetter: string,
  rootAcc: number,
  label: string,
  baseOctave: number,
): Note {
  const [deg, semis] = INTERVAL_META[label];
  const letter = LETTER_ORDER[(LETTER_ORDER.indexOf(rootLetter) + deg - 1) % 7];
  const rootMidi = 12 * (baseOctave + 1) + LETTER_PC[rootLetter] + rootAcc;
  const target = rootMidi + semis;
  const natural = LETTER_PC[letter];
  const acc = (((((target % 12) - natural + 6) % 12) + 12) % 12) - 6; // in [-6, 5]
  const octave = Math.floor((target - acc - natural) / 12) - 1;
  return { letter, octave, acc, midi: target };
}

/** Emit ABC for one note, writing an accidental only when it differs from what
 * is already sounding for that (letter, octave) within the bar. */
function renderNote(
  note: Note,
  keysig: Record<string, number>,
  state: Record<string, number>,
): string {
  const stateKey = `${note.letter}${note.octave}`;
  const current = state[stateKey] ?? keysig[note.letter] ?? 0;
  let sym = '';
  if (note.acc !== current) {
    sym = accSymbol(note.acc);
    state[stateKey] = note.acc;
  }
  let pitch: string;
  if (note.octave >= 5) {
    pitch = note.letter.toLowerCase() + "'".repeat(note.octave - 5);
  } else if (note.octave <= 3) {
    pitch = note.letter + ','.repeat(4 - note.octave);
  } else {
    pitch = note.letter;
  }
  return `${sym}${pitch}`;
}

/** Per-letter accidental of a key's signature, e.g. K:F → {B: -1}. */
function keySignature(keyStr: string): Record<string, number> {
  const { tonicPc, tonicLetter, intervals } = parseKey(keyStr);
  const sig: Record<string, number> = {};
  const ti = LETTER_ORDER.indexOf(tonicLetter);
  for (let deg = 0; deg < intervals.length; deg++) {
    const letter = LETTER_ORDER[(ti + deg) % 7];
    sig[letter] =
      ((((((tonicPc + intervals[deg]) % 12) - LETTER_PC[letter] + 6) % 12) + 12) %
        12) -
      6;
  }
  return sig;
}

/** (`Bb`) → (`B`, -1); (`F#`) → (`F`, 1). */
function parseNote(s: string): [string, number] {
  let acc = 0;
  for (const ch of s.slice(1)) acc += ch === '#' ? 1 : ch === 'b' ? -1 : 0;
  return [s[0], acc];
}

/** ABC length suffix for a duration of [frac] default-note-length (1/4) units. */
function abcLength(frac: Frac): string {
  if (frac.den === 1) return frac.num === 1 ? '' : `${frac.num}`;
  if (frac.num === 1) return `/${frac.den}`;
  return `${frac.num}/${frac.den}`;
}

function measureQuartersFor(meter: string): Frac {
  const [num, den] = meterNumDen(meter);
  if (num === null) return new Frac(4, 1); // free meter -> default 4
  return new Frac(4 * num, den as number);
}

/**
 * The length of ONE comping beat, in quarter-note units.
 *
 * Compound meters (6/8, 9/8, 12/8, and their /16 cousins) pulse on the dotted
 * beat, not the quarter: a 9/8 slip jig has three dotted-quarter beats per bar,
 * not four and a half quarters. Counting quarters put the strokes at eighth
 * positions 1/3/5 against a pulse on 1/4/7 — audibly cross-rhythmic — and would
 * leave whole-bar chords (9/2 quarters, not a whole number) sustaining as one
 * stack with no comping at all.
 *
 * 3/8 is deliberately treated as simple: it is conventionally counted in three
 * eighths rather than as one dotted beat.
 */
function beatQuartersFor(meter: string): Frac {
  const [num, den] = meterNumDen(meter);
  if (num === null) return new Frac(1, 1); // free meter -> quarter beat
  // A dotted beat is three of the meter's own units: 3 * (4/den) quarters.
  return isCompoundMeter(meter) ? new Frac(12, den as number) : new Frac(1, 1);
}

function intervalsFor(type: string): string[] {
  const entry = loadVocabulary().entryByCanonical.get(type);
  if (!entry) {
    throw new RealizeError(`Unknown chord type "${type}" (not in chord_types.json).`);
  }
  return entry.intervalPattern;
}

// --------------------------------------------------------------------------- //
// Module-level constants
// --------------------------------------------------------------------------- //

const LETTER_ORDER = 'CDEFGAB';
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Interval label → [diatonic degree, semitones above root]. */
const INTERVAL_META: Record<string, [number, number]> = {
  '1': [1, 0],
  b2: [2, 1],
  '2': [2, 2],
  '#2': [2, 3],
  b3: [3, 3],
  '3': [3, 4],
  '4': [4, 5],
  '#4': [4, 6],
  b5: [5, 6],
  '5': [5, 7],
  '#5': [5, 8],
  b6: [6, 8],
  '6': [6, 9],
  bb7: [7, 9],
  b7: [7, 10],
  '7': [7, 11],
  maj7: [7, 11],
  b9: [2, 13],
  '9': [2, 14],
  '#9': [2, 15],
  '11': [4, 17],
  '#11': [4, 18],
  b13: [6, 20],
  '13': [6, 21],
};

function accSymbol(acc: number): string {
  switch (acc) {
    case -2:
      return '__';
    case -1:
      return '_';
    case 0:
      return '=';
    case 1:
      return '^';
    case 2:
      return '^^';
    default:
      return acc > 0 ? '^'.repeat(acc) : '_'.repeat(-acc);
  }
}

// --------------------------------------------------------------------------- //
// Frac — a small non-negative rational (mirrors Python's Fraction with
// limit_denominator(64), used for chord durations).
// --------------------------------------------------------------------------- //

export class Frac {
  readonly num: number;
  readonly den: number;

  constructor(n: number, d: number) {
    if (d === 0) throw new RealizeError('zero denominator');
    if (d < 0) {
      n = -n;
      d = -d;
    }
    const g = Frac.gcd(Math.abs(n), d);
    this.num = g === 0 ? 0 : n / g;
    this.den = g === 0 ? 1 : d / g;
  }

  static readonly ZERO = new Frac(0, 1);

  /** Best rational approximation of [x] with denominator <= [maxDen] (continued
   * fractions), matching `Fraction(x).limit_denominator(maxDen)` for the small
   * "nice" durations that occur (1, 1/2, 1/3, …). */
  static fromNumber(x: number, maxDen = 64): Frac {
    if (x === Math.round(x)) return new Frac(Math.round(x), 1);
    const a0 = Math.floor(x);
    let h0 = 1;
    let k0 = 0;
    let h1 = a0;
    let k1 = 1;
    let f = x - a0;
    while (Math.abs(f) > 1e-9) {
      const inv = 1 / f;
      const ai = Math.floor(inv);
      const h2 = ai * h1 + h0;
      const k2 = ai * k1 + k0;
      if (k2 > maxDen) break;
      h0 = h1;
      k0 = k1;
      h1 = h2;
      k1 = k2;
      f = inv - ai;
    }
    return new Frac(h1, k1);
  }

  add(o: Frac): Frac {
    return new Frac(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  mul(o: Frac): Frac {
    return new Frac(this.num * o.num, this.den * o.den);
  }

  sub(o: Frac): Frac {
    return new Frac(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  div(o: Frac): Frac {
    return new Frac(this.num * o.den, this.den * o.num);
  }

  /** -1 / 0 / 1 — exact rational comparison (denominators are always > 0). */
  cmp(o: Frac): number {
    const a = this.num * o.den;
    const b = o.num * this.den;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  private static gcd(a: number, b: number): number {
    while (b !== 0) {
      const t = b;
      b = a % b;
      a = t;
    }
    return a;
  }
}
