/**
 * Validation + the `parsed` interchange record. `parse()` produces the
 * structured model; this adds document-level checks (id stamp, required
 * headers, bar-fill, standalone-vs-attached, beat-aligned durations) and
 * assembles the **snake_case `parsed`** record suitable for storage or
 * interchange: header-derived metadata, the structure-preserving `form`, and
 * the flat `chords` array ({@link flattenForm}, in written order).
 *
 * No content hash is computed here: how (and whether) to fingerprint a
 * document for de-duplication is left to the caller.
 */

import { isCompoundMeter, lengthToFraction, meterNumDen } from './meter.js';
import { parse, parseStructure } from './parse.js';
import type { Form, FormChord } from './parse.js';
import type { BarlineToken, FinalBarline } from './parseBody.js';
import { PART_RE } from './parseBody.js';

const EPS = 1e-9;
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// ABC info fields (A–Z minus J/Y, plus m/r/s/w) + the .chords-specific extras.
const KNOWN_HEADER_FIELDS = new Set([
  ...'ABCDEFGHIKLMNOPQRSTUVWXZ',
  ...'mrsw',
  'Y',
  'AK',
  'PIECE',
]);

/** One chord in the flat `chords` array (snake_case, storage shape). */
export interface FlatChord {
  bar: number;
  beat: number;
  degree: string | null;
  type: string | null;
  bass_degree?: string;
}

/** One chord in the snake_case `parsed.form`. */
export interface DbFormChordFull {
  token?: string;
  root?: string;
  type?: string | null;
  degree?: string | null;
  bass?: string;
  bass_degree?: string;
  units: number;
  beat: number;
  no_chord?: true;
}

export interface DbFormFull {
  bars: {
    bar: number;
    volta: number | null;
    annotations: string[];
    chords: DbFormChordFull[];
    /** 0-based authored body-line index (for line-faithful chart wrapping). */
    line?: number;
    /** The barline that opens this bar — the faithful per-bar repeat/section
     * structure (see [Form] `leadingBarline`). */
    leading_barline?: BarlineToken;
  }[];
  final_barline: FinalBarline;
}

/** The snake_case interchange record produced by {@link validateChords}. */
export interface ParsedChords {
  version: string | null;
  id: string | null;
  song_title: string | null;
  composer: string | null;
  year_published: number | string | null;
  rhythm: string | null;
  tempo: string | null;
  parts: string[];
  piece_id: string | null;
  time_signature: string;
  form_length: number;
  canonical_key: string | null;
  has_fixed_key: boolean;
  chords: FlatChord[];
  form: DbFormFull;
}

export interface ChordsValidationResult {
  errors: string[];
  warnings: string[];
  /** The interchange record, or null if the file has errors. */
  parsed: ParsedChords | null;
}

/**
 * Flatten a `Form` into its written chord sequence (the `chords` array), in
 * written order — **repeats/voltas are NOT expanded**. Structure is syntactic in
 * `.chords`: comparison and dedup operate on the written form, so this flattener
 * never unrolls a repeat.
 *
 * @param form - A parsed form (e.g. `parse(text).form`).
 * @returns One entry per written chord, with 1-based `bar` numbers.
 */
export function flattenForm(form: Form): FlatChord[] {
  const out: FlatChord[] = [];
  form.bars.forEach((bar, i) => {
    for (const c of bar.chords) {
      const entry: FlatChord = {
        bar: i + 1,
        beat: c.beat,
        degree: c.degree ?? null,
        type: c.type ?? null,
      };
      if (c.bassDegree) entry.bass_degree = c.bassDegree;
      out.push(entry);
    }
  });
  return out;
}

/** Serialize a camelCase `FormChord` to the snake_case `parsed.form` shape. */
function toDbFormChord(c: FormChord): DbFormChordFull {
  if (c.noChord) {
    return { token: c.token, no_chord: true, units: c.units, beat: c.beat };
  }
  const out: DbFormChordFull = {
    token: c.token,
    root: c.root,
    units: c.units,
    beat: c.beat,
    type: c.type,
    degree: c.degree ?? null,
  };
  if (c.bass !== undefined) out.bass = c.bass;
  if (c.bassDegree !== undefined) out.bass_degree = c.bassDegree;
  return out;
}

function toDbForm(form: Form): DbFormFull {
  return {
    bars: form.bars.map((b) => ({
      bar: b.bar,
      volta: b.volta,
      annotations: b.annotations,
      chords: b.chords.map(toDbFormChord),
      line: b.line,
      leading_barline: b.leadingBarline,
    })),
    final_barline: form.finalBarline,
  };
}

function parseYear(y: string | undefined): number | string | null {
  if (y === undefined || y === '') return null;
  const n = Number(y);
  return Number.isInteger(n) ? n : y; // a non-integer Y: is surfaced as-is
}

/**
 * Durations must divide **smoothly** into the meter: every chord has to begin on
 * one of the bar's comping slots. The comping scaffold belongs to the meter, not
 * to the chords — so a chord that starts between two slots can never be comped
 * as written, and the realizer would have to invent something (a short leading
 * stab) that the author did not ask for. Rejecting the chart is clearer than
 * guessing.
 *
 * A bar holds `n` slots — one per felt beat, a quarter in simple meters and a
 * dotted quarter in compound ones — so the rule in one line is: **every chord
 * duration is a whole multiple of 1/n of a bar.** 4/4 → quarters (`/2`, `/4`,
 * `3/4`, whole); 3/4 → thirds (`2/3` + `/3`, never `/2`); 6/8 → halves (the
 * dotted-quarter beats); 5/4 → fifths (so a 2+3 grouping, `2/5` + `3/5`, is
 * expressible). A meter whose bar is not a whole number of beats (3/8) has no
 * grid, and is not checked — the realizer sustains those spans rather than
 * comping them.
 *
 * Hemiola and other deliberately off-grid rhythms are not supported; they
 * would need custom comping patterns rather than a looser check here.
 *
 * @returns One error message per offending bar (empty if all bars are fine).
 */
function smoothDurationErrors(form: Form, meter: string, lFrac: number): string[] {
  let mNum: number | null;
  let mDen: number | null;
  try {
    [mNum, mDen] = meterNumDen(meter);
  } catch {
    return []; // parse() already reported the M: error
  }
  if (mNum === null) return [];
  const measureQuarters = (4 * mNum) / (mDen as number);
  const beatQuarters = isCompoundMeter(meter) ? 12 / (mDen as number) : 1;
  const slots = measureQuarters / beatQuarters;
  if (Math.abs(slots - Math.round(slots)) > EPS) return []; // no whole-beat grid
  const n = Math.round(slots);
  if (n < 2) return [];

  const errors: string[] = [];
  for (const [i, bar] of form.bars.entries()) {
    let offset = 0; // this chord's onset, in slots from the barline
    for (const c of bar.chords) {
      if (offset > EPS && Math.abs(offset - Math.round(offset)) > EPS) {
        const token = c.token ?? c.symbol ?? 'chord';
        errors.push(
          `Bar ${i + 1}: '${token}' starts ${offset.toFixed(2)} beats into the ` +
            `bar, which is not one of the ${n} comping slots of ${meter}. Every ` +
            `chord must start on a beat, so in ${meter} each duration is a whole ` +
            `multiple of 1/${n} of a bar (${smoothExamples(n)}).`,
        );
        break; // one message per bar — the rest of the bar is off-grid too
      }
      offset += c.units * lFrac * n;
    }
  }
  return errors;
}

/** A couple of legal duration suffixes for an `n`-slot bar, for the error text. */
function smoothExamples(n: number): string {
  if (n === 2) return 'C/2, or a bare C for the whole bar';
  return `C/${n}, C2/${n}, …, or a bare C for the whole bar`;
}

/** Options for {@link validateChords}. */
export interface ValidateOptions {
  /**
   * Require the `% id:` UUID stamp (default `true`). Set `false` to validate
   * a draft that has not been assigned an id yet. A *present but malformed*
   * id is still flagged either way.
   */
  requireId?: boolean;
}

/**
 * Validate one `.chords` document and assemble its `parsed` interchange record.
 *
 * Runs every check from {@link parse} plus the document-level rules: a valid
 * `% id:` UUID (unless `requireId` is false), the required `M:`, `L:` and `K:`
 * headers, either `T:` or `PIECE:`, at least one bar, every bar filling exactly
 * one measure, and every chord starting on a beat. Unrecognized header fields
 * produce warnings, not errors. Never throws; problems are reported in the
 * result.
 *
 * @param text - The `.chords` document.
 * @param options - See {@link ValidateOptions}.
 * @returns `errors`, `warnings`, and the `parsed` record (null when there are
 *   errors).
 *
 * @example
 * const { errors, parsed } = validateChords(text, { requireId: false });
 * if (errors.length === 0) console.log(parsed!.canonical_key);
 */
export function validateChords(
  text: string,
  { requireId = true }: ValidateOptions = {},
): ChordsValidationResult {
  const result = parse(text);
  const errors = [...result.errors];
  const warnings: string[] = [];
  const headers = result.headers;

  // id stamp (a UUID identifying this file).
  if (result.id === null) {
    if (requireId) {
      errors.push("Missing '% id:' stamp (a UUID identifying this file).");
    }
  } else if (!UUID_RE.test(result.id)) {
    errors.push(`'% id:' value '${result.id}' is not a valid UUID.`);
  }

  // required headers
  for (const field of ['M', 'L', 'K'] as const) {
    if (!headers[field]) errors.push(`Missing required header ${field}:.`);
  }
  // unrecognized header fields → warning (passed-through fields are ignored)
  for (const field of Object.keys(headers)) {
    if (!KNOWN_HEADER_FIELDS.has(field)) {
      warnings.push(
        `Header '${field}:' is not a recognized ABC information field; ` +
          'it will be ignored (not passed through to the rendered notation).',
      );
    }
  }

  // standalone (T:) vs attached (PIECE:)
  if (!headers.PIECE && !headers.T) {
    errors.push('A file must have either T: (standalone song) or PIECE: (attached tune).');
  }

  // bar-fill: each written bar's chord units must sum to exactly one measure.
  let lFrac: number | null = null;
  if (headers.L) {
    try {
      lFrac = lengthToFraction(headers.L);
    } catch {
      /* parse() already reported the L: error */
    }
  }
  let freeMeter = false;
  if (headers.M) {
    try {
      freeMeter = meterNumDen(headers.M)[0] === null;
    } catch {
      /* parse() already reported the M: error */
    }
  }
  if (result.form.bars.length === 0) {
    errors.push('No chord bars found in the body.');
  }
  if (lFrac !== null && !freeMeter) {
    result.form.bars.forEach((bar, i) => {
      const barTotal = bar.chords.reduce((s, c) => s + c.units, 0) * lFrac!;
      if (Math.abs(barTotal - 1) > EPS) {
        errors.push(
          `Bar ${i + 1} fills ${barTotal} of a measure but must fill exactly 1 ` +
            '(one full measure — a bare chord = a whole bar; use C/2, C/3 … for ' +
            'fractions of a bar).',
        );
      }
    });
    errors.push(...smoothDurationErrors(result.form, headers.M, lFrac));
  }

  if (errors.length > 0) return { errors, warnings, parsed: null };

  const { bodyLines } = parseStructure(text);
  const parts = bodyLines
    .map((l) => PART_RE.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1].trim());

  const parsed: ParsedChords = {
    version: result.version,
    id: result.id,
    song_title: headers.T ?? null,
    composer: headers.C ?? null,
    year_published: parseYear(headers.Y),
    rhythm: headers.R || null,
    tempo: headers.Q || null,
    parts,
    piece_id: headers.PIECE ?? null,
    time_signature: headers.M,
    form_length: result.form.bars.length,
    canonical_key: result.canonicalKey,
    has_fixed_key: result.hasFixedKey,
    chords: flattenForm(result.form),
    form: toDbForm(result.form),
  };
  return { errors, warnings, parsed };
}
