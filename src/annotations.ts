/**
 * Pass-through annotations → ABC.
 *
 * `parseBody` already carries every non-chord token a bar picks up — quoted
 * `"…"` text, `!…!` decorations, the D.C./D.S. navigation marks, and the bare
 * `S` / `O` segno/coda shorthands — as that bar's `annotations`. This module is
 * the ONE place that says how such an annotation is written back out as ABC, so
 * the `.chords`-text realizer and the stored-form realizer cannot disagree about
 * what a segno looks like.
 *
 * The distinction that matters: abcjs draws a REAL music glyph only for a
 * decoration it knows (`!segno!`, `!coda!`, `!D.C.alfine!`, …). Anything else
 * has to fall back to a text annotation above the staff (`"^…"`), which is what
 * a plain quoted annotation like `"intro"` emits. That fallback output is
 * pinned by reference-output tests, so it must not change.
 */

/**
 * The navigation/repeat decorations abcjs draws as glyphs, taken from its own
 * `legalAccents` table (verified against abcjs v6.6.3).
 * Deliberately only the navigation family: a decoration that has nothing to do
 * with repeat structure (a fermata, a trill) still passes through by the same
 * route because the author wrote it inside `!…!` — see {@link annotationToAbc}.
 */
const ABC_NAV_DECORATIONS = new Set([
  'segno',
  'coda',
  'fine',
  'D.S.',
  'D.C.',
  'D.C.alcoda',
  'D.C.alfine',
  'D.S.alcoda',
  'D.S.alfine',
]);

/** Bare ABC shorthands, as `.chords` authors write them in a bar. */
const NAV_SHORTHAND: Record<string, string> = {
  S: 'segno',
  O: 'coda',
};

/**
 * Normalize an author's spelling of a navigation mark to abcjs's own name:
 * spaces dropped and the dots regularised, so `D.C. al fine`, `DC al Fine` and
 * `D.C.alfine` all reach the same decoration. Returns the input unchanged when
 * it does not look like one of the marks.
 */
function normalizeNavName(raw: string): string {
  const compact = raw.replace(/\s+/g, '');
  const m = /^(D\.?C\.?|D\.?S\.?)(al(coda|fine))?$/i.exec(compact);
  if (!m) return raw;
  const head = m[1].toUpperCase().replace(/\./g, '') === 'DC' ? 'D.C.' : 'D.S.';
  if (!m[2]) return head;
  return `${head}al${m[3].toLowerCase()}`;
}

/**
 * Is [value] one of the navigation decorations abcjs can draw?
 *
 * [value] is an annotation as `parseBody` carries it — i.e. with the `"…"` /
 * `!…!` delimiters already stripped.
 */
export function isAbcNavDecoration(value: string): boolean {
  const name = NAV_SHORTHAND[value] ?? normalizeNavName(value.trim());
  return ABC_NAV_DECORATIONS.has(name);
}

/**
 * Render one carried annotation as ABC.
 *
 * A recognized navigation mark becomes the real decoration (`S` → `!segno!`,
 * `!D.C. al fine!` → `!D.C.alfine!`) so abcjs engraves the symbol; everything
 * else becomes a text annotation above the staff, with inner double quotes
 * swapped for apostrophes so the emitted string stays well-formed.
 *
 * ABC decorations attach to the note that follows them, so a caller must emit
 * the result INSIDE a bar (after the barline, before the bar's content) — never
 * between a bar's content and the next barline.
 */
export function annotationToAbc(value: string): string {
  const name = NAV_SHORTHAND[value] ?? normalizeNavName(value.trim());
  if (ABC_NAV_DECORATIONS.has(name)) return `!${name}!`;
  return `"^${value.replace(/"/g, "'")}"`;
}
