/**
 * The top-level `.chords` parser. Turns `.chords` text into the
 * structure-preserving `form` (bars in written order, repeats/voltas kept) plus
 * the file's headers, directives, and any errors found along the way.
 *
 * The `form` carries each chord's absolute root + canonical type + optional
 * bass + units + beat, plus the key-aware Roman `degree`/`bassDegree`. Field
 * names are camelCase; `formToDbForm` maps a `Form` to the snake_case `DbForm`
 * shape the realizer consumes.
 */

import { MusicKey, parseKey, romanFields } from './key.js';
import { lengthToFraction, meterNumDen } from './meter.js';
import { isNoChord, ParsedChord } from './parseChord.js';
import {
  BarlineToken,
  FinalBarline,
  ParsedBody,
  parseBody,
} from './parseBody.js';

const VERSION_LINE = '%chords-1.0';
const HEADER_RE = /^([A-Za-z]+):(.*)$/;
const ID_RE = /^%\s*id:\s*(\S+)\s*$/;
/** An ABC-style `%%directive value` line, anywhere in the document. */
const DIRECTIVE_RE = /^%%([A-Za-z][A-Za-z0-9_-]*)\s*(.*)$/;

/** A chord in the structured `form`. */
export interface FormChord {
  /** The raw token as written, incl. any duration suffix (e.g. `Am7/2`). */
  token?: string;
  /** As-written chord symbol (root + quality + optional /bass), no duration. */
  symbol?: string;
  /** Absolute root, e.g. `C`, `Bb`, `F#`. */
  root?: string;
  /** Canonical type, e.g. `min7`; null for a no-chord. */
  type: string | null;
  /** Slash bass, e.g. `E`. */
  bass?: string;
  /** Key-aware Roman degree (cased), or null (no key / no chord). */
  degree?: string | null;
  bassDegree?: string;
  /** Duration in `L:` units. */
  units: number;
  /** 1-based beat position within the bar. */
  beat: number;
  noChord?: true;
}

export interface FormBar {
  bar: number;
  volta: number | null;
  annotations: string[];
  chords: FormChord[];
  /** 0-based authored body-line index this bar sits on. Optional so hand-built
   * forms without it still validate; chart line-faithful wrapping is used only
   * when every bar carries it. */
  line?: number;
  /** The barline that opens this bar (`plain`/`repeatOpen`/`repeatClose`/
   * `repeatBoth`/`none`) — the whole repeat/section structure, kept faithfully
   * per bar (see [BarlineToken]). Optional for hand-built forms (treated as
   * `plain`, or `none` for the first bar). */
  leadingBarline?: BarlineToken;
}

export interface Form {
  bars: FormBar[];
  /** The barline that closes the progression: `final` (`|]`) or `repeatClose`
   * (a section repeating to the end). */
  finalBarline: FinalBarline;
}

export interface ParseResult {
  version: string | null;
  /** The `% id:` stamp, if present. */
  id: string | null;
  /** Raw header fields (`M`, `L`, `K`, `T`, …). */
  headers: Record<string, string>;
  /** ABC-style `%%name value` directives, by name (see {@link Structure}). */
  directives: Record<string, string>;
  title?: string;
  composer?: string;
  /** The notation key (the `K:` value) when the `AK:` header is true (the
   * default), else null. */
  canonicalKey: string | null;
  hasFixedKey: boolean;
  meter: string | null;
  form: Form;
  errors: string[];
}

export interface Structure {
  version: string | null;
  id: string | null;
  headers: Record<string, string>;
  /**
   * ABC-style `%%name value` directives, by name — e.g. `%%barnumbers 4` →
   * `{ barnumbers: '4' }`.
   *
   * chords-js follows abcjs here: ABC-standard machinery is either UNDERSTOOD
   * (when it has a chart meaning) or PASSED THROUGH cleanly — never an error,
   * never silently dropped. Directives are otherwise `%` comments, so they are
   * collected here to let a renderer or a downstream tool act on them.
   * `%%barnumbers` and `%%setbarnb` are the two the chart currently
   * understands; the rest ride along untouched.
   */
  directives: Record<string, string>;
  bodyLines: string[];
  errors: string[];
}

/**
 * Split `.chords` text into version / id / headers / directives / body lines,
 * without parsing the body. Header lines are those before the first body line
 * (a `P:` line always starts the body). Problems such as a missing version line
 * are reported in `errors`; this function does not throw.
 */
export function parseStructure(text: string): Structure {
  const errors: string[] = [];
  let version: string | null = null;
  let id: string | null = null;
  const headers: Record<string, string> = {};
  const directives: Record<string, string> = {};
  const bodyLines: string[] = [];
  let seenBody = false;
  let seenVersion = false;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const stripped = line.trim();
    if (stripped === '') continue;

    if (stripped.startsWith('%')) {
      if (!seenVersion) {
        if (stripped === VERSION_LINE) {
          version = '1.0';
          seenVersion = true;
        } else if (ID_RE.test(stripped) || stripped.startsWith('%chords')) {
          errors.push(
            `First line must be the version line '${VERSION_LINE}', found '${stripped}'.`,
          );
          seenVersion = true;
        }
      }
      const m = ID_RE.exec(stripped);
      if (m) id = m[1];
      const dm = DIRECTIVE_RE.exec(stripped);
      if (dm) directives[dm[1]] = dm[2].trim();
      continue;
    }

    if (!seenVersion) {
      errors.push(
        `First line must be the version line '${VERSION_LINE}', found '${stripped}'.`,
      );
      seenVersion = true;
    }

    const hm = HEADER_RE.exec(stripped);
    // P: is a body part marker, never a header — even right after the headers.
    if (hm && !seenBody && hm[1] !== 'P') {
      headers[hm[1]] = hm[2].trim();
    } else {
      seenBody = true;
      bodyLines.push(stripped);
    }
  }

  if (version === null && !errors.some((e) => e.includes('version line'))) {
    errors.push(`Missing version line '${VERSION_LINE}' on the first line.`);
  }
  return { version, id, headers, directives, bodyLines, errors };
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/**
 * Assemble the structure-preserving `form` from an already-parsed body. Adds the
 * per-chord `beat` (cumulative `units × lFrac`, 1-based) and the key-aware Roman
 * fields. With no `L:` (`lFrac === null`), every beat is 1.0.
 */
export function buildForm(
  pb: ParsedBody,
  key: MusicKey | null,
  lFrac: number | null,
  beatsPerMeasure: number,
): Form {
  const bars: FormBar[] = pb.bars.map((b, idx) => {
    let offset = 0; // position within the bar, in measures
    const chords: FormChord[] = [];
    for (const c of b.chords) {
      const beat = lFrac ? round6(offset * beatsPerMeasure + 1) : 1.0;
      if (isNoChord(c)) {
        chords.push({ token: c.token, noChord: true, type: null, units: c.units, beat });
      } else {
        const pc: ParsedChord = c;
        const rf = romanFields(pc, key);
        const fc: FormChord = {
          token: pc.token,
          symbol: pc.symbol,
          root: pc.root + pc.rootAcc,
          type: pc.canonical,
          units: pc.units,
          beat,
          degree: rf.degree,
        };
        if (pc.bass !== null) fc.bass = pc.bass + (pc.bassAcc ?? '');
        if (rf.bassDegree) fc.bassDegree = rf.bassDegree;
        chords.push(fc);
      }
      if (lFrac) offset += c.units * lFrac;
    }
    return {
      bar: idx + 1,
      volta: b.volta,
      annotations: b.annotations,
      chords,
      line: b.line,
      leadingBarline: b.leadingBarline,
    };
  });
  return {
    bars,
    finalBarline: pb.finalBarline,
  };
}

/**
 * Parse a full `.chords` document into headers + the structured `form`.
 *
 * Never throws: malformed headers (`M:`, `L:`, `K:`, `AK:`), unknown chord
 * tokens, and a missing version line are all collected in `errors`, and the
 * rest of the document is still parsed. Check `errors.length` before trusting
 * the result.
 *
 * @example
 * const { form, errors } = parse('%chords-1.0\nM:4/4\nL:1/1\nK:C\n| C | G7 |]');
 */
export function parse(text: string): ParseResult {
  const s = parseStructure(text);
  const errors = [...s.errors];

  let beatsPerMeasure = 4;
  let lFrac: number | null = null;
  let key: MusicKey | null = null;

  if (s.headers.M) {
    try {
      const [num] = meterNumDen(s.headers.M);
      beatsPerMeasure = num ?? 4;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (s.headers.L) {
    try {
      lFrac = lengthToFraction(s.headers.L);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (s.headers.K) {
    try {
      key = parseKey(s.headers.K);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // AK: (absolute-key flag) defaults to true.
  const akRaw = (s.headers.AK ?? '').trim().toLowerCase();
  let hasFixedKey = true;
  if (akRaw === 'false') {
    hasFixedKey = false;
  } else if (akRaw !== '' && akRaw !== 'true') {
    errors.push(`AK: '${s.headers.AK}' must be true or false.`);
  }

  const pb = parseBody(s.bodyLines.join('\n'));
  errors.push(...pb.errors);
  const form = buildForm(pb, key, lFrac, beatsPerMeasure);

  return {
    version: s.version,
    id: s.id,
    headers: s.headers,
    directives: s.directives,
    title: s.headers.T,
    composer: s.headers.C,
    canonicalKey: hasFixedKey ? (s.headers.K ?? null) : null,
    hasFixedKey,
    meter: s.headers.M ?? null,
    form,
    errors,
  };
}
