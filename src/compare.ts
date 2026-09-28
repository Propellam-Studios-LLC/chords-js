/**
 * Compare two chord progressions (two parsed `Form`s), producing a per-chord
 * harmonic score and a structural diff.
 *
 * **Harmonic** comparison is per **written** bar (repeats not expanded), aligning
 * chords within each bar by position. Each chord pair earns weighted partial
 * credit: the root is a gate (wrong root → 0), then quality / seventh /
 * extensions / bass each add credit. By default chords are compared by their
 * key-independent Roman **degree** (so the same progression in two keys compares
 * equal); set `byDegree: false` to compare absolute roots. On top of the harmonic
 * score is a light **structural** diff (bar count, repeat span, voltas).
 */

import { loadVocabulary, ChordVocabulary } from './chordTypes.js';
import { parseRomanDegree } from './key.js';
import type { Form, FormChord } from './parse.js';

// Component weights; they sum to 1. The root is a gate: wrong root → 0.
const W_ROOT = 0.4;
const W_QUALITY = 0.3;
const W_SEVENTH = 0.15;
const W_EXTENSIONS = 0.1;
const W_BASS = 0.05;

/** Per-chord mark: chord from `a` vs chord from `b`, with a multilevel
 * breakdown and fractional `credit` (0–1). A null `a` is an extra chord (in `b`
 * only); a null `b` a missing one. */
export interface ChordMark {
  a: FormChord | null;
  b: FormChord | null;
  rootOk: boolean;
  typeOk: boolean;
  qualityOk: boolean;
  seventhOk: boolean;
  extensionsOk: boolean;
  bassOk: boolean;
  credit: number;
  correct: boolean;
}

/** One written bar's marks. */
export interface BarComparison {
  bar: number; // 1-based
  marks: ChordMark[];
  allCorrect: boolean;
}

/** A light structural diff between the two forms. Structure is compared
 * **token-by-token** on the faithful written form — the per-bar leading barlines
 * and the final barline — never by expanding repeats/voltas. */
export interface StructuralDiff {
  barCountA: number;
  barCountB: number;
  /** A per-bar leading barline (within the shared range) or the final barline
   * differs — i.e. the repeat/section structure was written differently. */
  repeatChanged: boolean;
  /** True when the highest volta number written differs. */
  maxVoltaChanged: boolean;
  /** 1-based bars (within the shared range) whose `volta` differs. */
  voltaBars: number[];
}

/** The outcome of {@link compare}. */
export interface CompareResult {
  bars: BarComparison[];
  /** Number of chords in `a`. */
  expectedTotal: number;
  /** Fully-correct chords. */
  correct: number;
  /** Mean per-chord credit (0–1); extras/missing dilute it. */
  harmonicScore01: number;
  structural: StructuralDiff;
  /** Harmonically perfect (every chord exact, none extra/missing) AND no
   * structural difference. */
  identical: boolean;
}

export interface CompareOptions {
  /** Compare by key-independent Roman degree when available (default true);
   * else by absolute root. */
  byDegree?: boolean;
}

/**
 * Compare progression `a` (the reference) with `b`.
 *
 * Bars are matched by written position, and chords within a bar by their
 * position in it; nothing is expanded or realigned, so an inserted bar shifts
 * every later comparison.
 *
 * @param a - The reference form (e.g. `parse(text).form`).
 * @param b - The form to compare against it.
 * @param opts - See {@link CompareOptions}.
 * @returns Per-bar marks, overall counts and score, and the structural diff.
 *
 * @example
 * const r = compare(parse(original).form, parse(attempt).form);
 * console.log(r.correct, '/', r.expectedTotal, r.harmonicScore01);
 */
export function compare(a: Form, b: Form, opts: CompareOptions = {}): CompareResult {
  const byDegree = opts.byDegree ?? true;
  const vocab = loadVocabulary();

  const barCount = Math.max(a.bars.length, b.bars.length);
  const bars: BarComparison[] = [];
  let expectedTotal = 0;
  let correct = 0;
  let creditSum = 0;
  let slots = 0;
  let extra = 0;

  for (let i = 0; i < barCount; i++) {
    const aBar = i < a.bars.length ? a.bars[i].chords : [];
    const bBar = i < b.bars.length ? b.bars[i].chords : [];
    const chordCount = Math.max(aBar.length, bBar.length);
    const marks: ChordMark[] = [];
    for (let j = 0; j < chordCount; j++) {
      const ac = j < aBar.length ? aBar[j] : null;
      const bc = j < bBar.length ? bBar[j] : null;
      if (ac !== null) expectedTotal++;
      if (ac === null && bc !== null) extra++;
      slots++;
      const mark = markChord(ac, bc, byDegree, vocab);
      if (mark.correct) correct++;
      creditSum += mark.credit;
      marks.push(mark);
    }
    bars.push({
      bar: i + 1,
      marks,
      allCorrect: marks.length > 0 && marks.every((m) => m.correct),
    });
  }

  const structural = structuralDiff(a, b);
  const harmonicScore01 = slots === 0 ? 0 : creditSum / slots;
  const identical =
    expectedTotal > 0 &&
    correct === expectedTotal &&
    extra === 0 &&
    structural.barCountA === structural.barCountB &&
    !structural.repeatChanged &&
    !structural.maxVoltaChanged &&
    structural.voltaBars.length === 0;

  return { bars, expectedTotal, correct, harmonicScore01, structural, identical };
}

function structuralDiff(a: Form, b: Form): StructuralDiff {
  const shared = Math.min(a.bars.length, b.bars.length);
  const voltaBars: number[] = [];
  let repeatChanged = (a.finalBarline ?? 'final') !== (b.finalBarline ?? 'final');
  const lead = (f: Form, i: number): string =>
    f.bars[i].leadingBarline ?? (i === 0 ? 'none' : 'plain');
  for (let i = 0; i < shared; i++) {
    if (a.bars[i].volta !== b.bars[i].volta) voltaBars.push(i + 1);
    // Compare the written barline at each bar (token-by-token, no expansion).
    if (lead(a, i) !== lead(b, i)) repeatChanged = true;
  }
  const maxVolta = (f: Form): number =>
    f.bars.reduce((m, bar) => Math.max(m, bar.volta ?? 0), 0);
  return {
    barCountA: a.bars.length,
    barCountB: b.bars.length,
    repeatChanged,
    maxVoltaChanged: maxVolta(a) !== maxVolta(b),
    voltaBars,
  };
}

const EMPTY_MARK = (a: FormChord | null, b: FormChord | null): ChordMark => ({
  a,
  b,
  rootOk: false,
  typeOk: false,
  qualityOk: false,
  seventhOk: false,
  extensionsOk: false,
  bassOk: false,
  credit: 0,
  correct: false,
});

function markChord(
  a: FormChord | null,
  b: FormChord | null,
  byDegree: boolean,
  vocab: ChordVocabulary,
): ChordMark {
  if (a === null || b === null) return EMPTY_MARK(a, b);

  // N.C.: two no-chords match exactly; a no-chord vs a chord does not.
  if (a.noChord || b.noChord) {
    const both = !!a.noChord && !!b.noChord;
    return {
      a,
      b,
      rootOk: both,
      typeOk: both,
      qualityOk: both,
      seventhOk: both,
      extensionsOk: both,
      bassOk: both,
      credit: both ? 1 : 0,
      correct: both,
    };
  }

  const typeOk = a.type === b.type;
  const rootOk = posMatch(rootKey(a, byDegree), rootKey(b, byDegree), byDegree);
  if (!rootOk) return { ...EMPTY_MARK(a, b), typeOk };

  const bassOk = posMatch(bassKey(a, byDegree), bassKey(b, byDegree), byDegree);
  const ai = vocab.entryByCanonical.get(a.type as string);
  const bi = vocab.entryByCanonical.get(b.type as string);
  // Suspended chords share a 'quality' (sus2 vs sus4) — require the exact type.
  const qualityOk =
    !!ai && !!bi && ai.quality === bi.quality && (ai.quality !== 'suspended' || typeOk);
  const seventhOk =
    !!ai && !!bi && ai.hasSeventh === bi.hasSeventh && ai.seventhType === bi.seventhType;
  const extensionsOk = !!ai && !!bi && sameSet(ai.extensions, bi.extensions);

  const credit =
    W_ROOT +
    (qualityOk ? W_QUALITY : 0) +
    (seventhOk ? W_SEVENTH : 0) +
    (extensionsOk ? W_EXTENSIONS : 0) +
    (bassOk ? W_BASS : 0);

  return {
    a,
    b,
    rootOk: true,
    typeOk,
    qualityOk,
    seventhOk,
    extensionsOk,
    bassOk,
    credit,
    correct: qualityOk && seventhOk && extensionsOk && bassOk,
  };
}

/** The value compared for the root: degree (when requested + present) else root. */
function rootKey(c: FormChord, byDegree: boolean): string | undefined {
  return byDegree ? (c.degree ?? c.root) : c.root;
}

function bassKey(c: FormChord, byDegree: boolean): string | undefined {
  return byDegree ? (c.bassDegree ?? c.bass) : c.bass;
}

/** Exact string for absolute notes; case-insensitive number+accidental for
 * degrees (so `ii` and `II` match). Both missing → match. */
function posMatch(a: string | undefined, b: string | undefined, byDegree: boolean): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (!byDegree) return a === b;
  const da = parseRomanDegree(a);
  const db = parseRomanDegree(b);
  if (da === null || db === null) return a === b; // e.g. absolute roots
  return da.number === db.number && da.accidental === db.accidental;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}
