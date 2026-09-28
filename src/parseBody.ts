/**
 * Parses a `.chords` body into tagged bars + repeat/volta structure (no
 * expansion — the written form is preserved).
 *
 * Quoted strings are pass-through **annotations** (ABC-style text), attached to
 * the bar they precede. Each bar's chord tokens are parsed via
 * [parseChordToken]; any token that fails to parse is collected in `errors`.
 */

import { ChordVocabulary, loadVocabulary } from './chordTypes.js';
import { NoChord, ParsedChord, parseChordToken } from './parseChord.js';
import { ParsedRomanChord, parseRomanChordToken } from './romanToken.js';

/**
 * The barline that *opens* a bar, kept as a first-class recognized token. The
 * `.chords` structure model is **syntactic, not semantic**: markers are preserved
 * losslessly in written order and never interpreted (no repeat expansion). This
 * is what makes multiple repeated sections, voltas, etc. round-trip for free.
 *
 * - `none` — the very first bar with no leading barline.
 * - `plain` — `|`.
 * - `repeatOpen` — `|:`.
 * - `repeatClose` — `:|`.
 * - `repeatBoth` — `::` (equivalently `:| |:` at one boundary).
 *
 * `||` is deliberately **not** vocabulary — the only measure delimiters are `|`
 * and `|]`; a stray `||` just decomposes to `|`.
 */
export type BarlineToken =
  | 'none'
  | 'plain'
  | 'repeatOpen'
  | 'repeatClose'
  | 'repeatBoth';

/** The barline that closes the whole progression: `|]` (final) or `:|` at the
 * end (a section repeating to the end, written `:|` / `:|]`). */
export type FinalBarline = 'final' | 'repeatClose';

export interface BodyBarOf<C> {
  chords: (C | NoChord)[];
  /** Volta ending number this bar belongs to (1, 2, …), or null. */
  volta: number | null;
  /** Pass-through text annotations attached to this bar (`"…"`, `!…!`, D.C./D.S.). */
  annotations: string[];
  /** 0-based index of the authored body line this bar was written on (after
   * dropping `P:` part-marker lines). Lets a chart wrap on the author's own
   * line breaks instead of a fixed bars-per-line. */
  line: number;
  /** The barline that opens this bar — the whole repeat/section structure, kept
   * faithfully per bar (see [BarlineToken]). */
  leadingBarline: BarlineToken;
}

export interface ParsedBodyOf<C> {
  bars: BodyBarOf<C>[];
  /** The barline closing the progression (see [FinalBarline]). */
  finalBarline: FinalBarline;
  errors: string[];
}

/** A bar of absolute chords. */
export type BodyBar = BodyBarOf<ParsedChord>;
/** A parsed body of absolute chords. */
export type ParsedBody = ParsedBodyOf<ParsedChord>;

/** A bar of Roman-numeral chords. */
export type RomanBodyBar = BodyBarOf<ParsedRomanChord>;
/** A parsed body of Roman-numeral chords. */
export type ParsedRomanBody = ParsedBodyOf<ParsedRomanChord>;

// Body tokenizer. Order matters: quoted / bang-delimited annotations first (may
// contain spaces), then the final barline, repeat markers, and volta markers
// before plain `|` and the chord pattern. `||` is intentionally absent. Exported
// (with the classifier) so the realizer can walk a body the same way.
export const BODY_TOKEN_RE =
  /"[^"]*"|![^!]*!|\|\]|\|:|:\||::|\[\d+|\|\d+|\||[^\s|:[\]"!]+/g;
const VOLTA_MARKER_RE = /^[[|](\d+)$/; // [1 or |2
/** Part/section marker line, e.g. `P: A`; group 1 = the label. */
export const PART_RE = /^P:\s*(.*)$/;
// Navigation marks (D.C./D.S. family) — recognized as pass-through annotations,
// not errors. Multi-word forms (e.g. "al fine") should be quoted or `!…!`-wrapped.
const NAV_RE = /^(D\.?C\.?|D\.?S\.?)$/i;
// Bare ABC decoration shorthands: `S` = segno, `O` = coda. Case-sensitive (a
// lowercase `s`/`o` is not the shorthand). Like the D.C./D.S. marks these pass
// through as annotations rather than failing as unknown chords; `O:` in header
// position is an info field handled before body tokenizing, so a bare body `O`
// is unambiguous.
const NAV_SHORTHAND_RE = /^[SO]$/;

export type TokenKind =
  | 'chord'
  | 'annotation'
  | 'bar'
  | 'rstart'
  | 'rend'
  | 'rboth'
  | 'final'
  | 'volta';

/** A bar's repeat brackets, derived from the faithful per-bar barline model for
 * renderers (chart, realizer) that draw/emit bracket-style repeats: a bar opens
 * a repeat when its own leading barline is `|:`/`::`, and closes one when the
 * *next* bar's leading barline is `:|`/`::` (or, for the last bar, the final
 * barline is a repeat-close). This is presentation only — the model itself never
 * interprets repeats. */
export function repeatBrackets(
  bars: { leadingBarline?: BarlineToken }[],
  finalBarline: FinalBarline,
): { open: boolean; close: boolean }[] {
  return bars.map((b, i) => {
    const lead: BarlineToken = b.leadingBarline ?? (i === 0 ? 'none' : 'plain');
    const nextLead: BarlineToken | null =
      i + 1 < bars.length ? (bars[i + 1].leadingBarline ?? 'plain') : null;
    return {
      open: lead === 'repeatOpen' || lead === 'repeatBoth',
      close:
        nextLead === 'repeatClose' ||
        nextLead === 'repeatBoth' ||
        (i === bars.length - 1 && finalBarline === 'repeatClose'),
    };
  });
}

/**
 * Classify one token matched by {@link BODY_TOKEN_RE}: an annotation (`"…"`,
 * `!…!`, a D.C./D.S. mark, or a bare `S`/`O`), a barline, a volta marker (with
 * its ending number as `value`), or — for anything else — a chord token to be
 * parsed. Never throws; chord validity is checked by the chord parser.
 */
export function classifyToken(tok: string): {
  kind: TokenKind;
  value: string | number | null;
} {
  if (tok.length >= 2 && tok.startsWith('"') && tok.endsWith('"')) {
    return { kind: 'annotation', value: tok.slice(1, -1) };
  }
  // `!…!` decorations pass straight through as annotations (abcjs interprets them).
  if (tok.length >= 2 && tok.startsWith('!') && tok.endsWith('!')) {
    return { kind: 'annotation', value: tok.slice(1, -1) };
  }
  if (tok === '|]') return { kind: 'final', value: null };
  if (tok === '|:') return { kind: 'rstart', value: null };
  if (tok === ':|') return { kind: 'rend', value: null };
  if (tok === '::') return { kind: 'rboth', value: null };
  if (tok === '|') return { kind: 'bar', value: null };
  const m = VOLTA_MARKER_RE.exec(tok);
  if (m) return { kind: 'volta', value: parseInt(m[1], 10) };
  if (/^\d+$/.test(tok)) return { kind: 'volta', value: parseInt(tok, 10) };
  // D.C./D.S. navigation marks pass through (carried, emitted to ABC, never
  // interpreted) rather than failing as an unknown chord.
  if (NAV_RE.test(tok)) return { kind: 'annotation', value: tok };
  // Bare segno (`S`) / coda (`O`) shorthands pass through the same way.
  if (NAV_SHORTHAND_RE.test(tok)) return { kind: 'annotation', value: tok };
  return { kind: 'chord', value: tok };
}

/**
 * The one body walker, parameterised by the token parser.
 *
 * Bar/repeat/volta/annotation handling is identical for absolute and Roman
 * vocabularies — only the per-chord-token parse differs — so there is exactly
 * one implementation of the splitter and neither vocabulary can drift from the
 * other on structure.
 */
function parseBodyWith<C>(
  body: string,
  parseToken: (tok: string, vocab: ChordVocabulary) => C | NoChord,
  vocab: ChordVocabulary,
): ParsedBodyOf<C> {
  const errors: string[] = [];
  // Part markers (P: …) are section labels, not bars — drop those lines. The
  // remaining body lines are tokenized one at a time so each bar can record the
  // authored line it sits on (for line-faithful chart wrapping); indices are
  // contiguous over content lines (P: lines are already removed).
  const contentLines = body
    .split('\n')
    .filter((l) => !PART_RE.test(l.trim()));

  const bars: BodyBarOf<C>[] = [];
  let current: (C | NoChord)[] = [];
  let pendingAnnotations: string[] = [];
  let voltaTag: number | null = null;
  // The barline that opens the bar currently being built. `none` for the first
  // bar; each barline token sets it for the *next* bar (pass-through, per bar —
  // this is the whole repeat/section structure).
  let currentLeading: BarlineToken = 'none';
  // Whether a barline token has been read since the last bar was flushed. The
  // volta rule below must only see a repeat barline written at THIS boundary
  // (`:|[2`, `|:[1`), not one left over from the bar before: in
  // `|: C |1 G :|2 F`, the `|:` opened C's bar and must not leak into G's.
  let leadingSetSinceFlush = false;
  let finalBarline: FinalBarline = 'final';
  // True once a `:|` is the trailing token (no chord after it) — i.e. the whole
  // progression closes with a repeat. Any following chord clears it.
  let endsWithRepeatClose = false;
  // The authored line currently being tokenized; a flushed bar is tagged with
  // the line where it closes (bars sit on one line in practice).
  let currentLine = 0;

  const flush = () => {
    if (current.length > 0) {
      bars.push({
        chords: current,
        volta: voltaTag,
        annotations: pendingAnnotations,
        line: currentLine,
        leadingBarline: currentLeading,
      });
      current = [];
      pendingAnnotations = [];
      leadingSetSinceFlush = false;
    }
  };

  // Set the leading barline for the *next* bar, merging `:|` then `|:` at one
  // boundary into `repeatBoth`.
  const setLeading = (b: BarlineToken) => {
    currentLeading =
      currentLeading === 'repeatClose' && b === 'repeatOpen' ? 'repeatBoth' : b;
    leadingSetSinceFlush = true;
  };

  for (let li = 0; li < contentLines.length; li++) {
    currentLine = li;
    for (const match of contentLines[li].matchAll(BODY_TOKEN_RE)) {
      const tok = match[0];
      const { kind, value } = classifyToken(tok);
      switch (kind) {
      case 'chord':
        try {
          current.push(parseToken(tok, vocab));
          endsWithRepeatClose = false;
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
        break;
      case 'annotation':
        pendingAnnotations.push(value as string);
        break;
      case 'bar':
        flush();
        setLeading('plain');
        break;
      case 'rstart':
        flush();
        setLeading('repeatOpen');
        break;
      case 'rend':
        flush();
        setLeading('repeatClose');
        finalBarline = 'repeatClose';
        endsWithRepeatClose = true;
        break;
      case 'rboth':
        flush();
        setLeading('repeatBoth');
        break;
      case 'final':
        flush();
        voltaTag = null; // a final barline closes any open volta
        finalBarline = 'final';
        endsWithRepeatClose = false;
        break;
      case 'volta':
        flush();
        // `|1` / `[1` also act as a plain barline opening the ending — but only
        // when no repeat barline is already pending: in `:|[2` (and `|:[1`) the
        // volta marker tags the ending without downgrading the repeat to plain.
        {
          // `includes` sidesteps TS narrowing away the closure writes to
          // `currentLeading` (it flow-narrows the literal comparisons to
          // 'none' and flags them as unintentional).
          const repeatPending = leadingSetSinceFlush && (
            ['repeatClose', 'repeatBoth', 'repeatOpen'] as BarlineToken[]
          ).includes(currentLeading);
          if ((tok.startsWith('|') || tok.startsWith('[')) && !repeatPending) {
            setLeading('plain');
          }
        }
        voltaTag = value as number;
        break;
      }
    }
  }
  flush();

  // Trailing/leading annotations with no following bar attach to the last bar.
  if (pendingAnnotations.length > 0 && bars.length > 0) {
    bars[bars.length - 1].annotations.push(...pendingAnnotations);
  }

  // The final barline is `repeatClose` only if a `:|` was the trailing token.
  finalBarline = endsWithRepeatClose ? 'repeatClose' : 'final';

  return { bars, finalBarline, errors };
}

/**
 * Parse a `.chords` body of ABSOLUTE chord symbols (`C`, `Am7`, `G7/B`).
 *
 * Does not throw on bad chords: each token that fails to parse adds a message
 * to `errors` and is left out of its bar.
 */
export function parseBody(
  body: string,
  vocab: ChordVocabulary = loadVocabulary(),
): ParsedBody {
  return parseBodyWith(body, parseChordToken, vocab);
}

/**
 * Parse a `.chords` body of ROMAN-NUMERAL chords (`i`, `bVII`, `V7`, `I/V`).
 *
 * **Takes no key**, deliberately: Roman is key-independent by design, so the
 * result keeps degrees rather than absolutes. Converting here would bind the
 * result to one key, and the same progression would then compare differently
 * depending on how it was entered. Use {@link romanChordsToSimpleBars} +
 * `romanBarsToAbsolute` when absolutes are wanted.
 *
 * The bar/repeat/volta/annotation structure is identical to {@link parseBody} —
 * same walker, same fields — so code that handles one result handles the other.
 * Unparseable tokens are reported in `errors`, as with {@link parseBody}.
 */
export function parseRomanBody(
  body: string,
  vocab: ChordVocabulary = loadVocabulary(),
): ParsedRomanBody {
  return parseBodyWith(body, parseRomanChordToken, vocab);
}
