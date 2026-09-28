/**
 * Transposition for chord progressions.
 *
 * A parsed `Form` carries each chord's key-independent Roman `degree` (e.g. `iv`,
 * `bVII`). To show / realize a progression in any key, turn each degree back into
 * an absolute note spelled in the target key (`degreeToNote`, the inverse of
 * `noteToDegree`). {@link transposeFormToKey} applies it across a whole `Form`.
 *
 * Structure (per-bar `leadingBarline`/`volta`/`annotations`/`line`, the form's
 * `finalBarline`, and each chord's `units`, `type`, `beat`) is preserved
 * unchanged; `noChord` bars pass through. Each transposed chord's `symbol` is
 * re-spelled in the target key, and its as-written `token` is dropped (it no
 * longer describes the chord). Realizing the result in the target key (via
 * `formToDbForm`) gives the progression transposed.
 */

import { chordSymbol } from './chordSymbol.js';
import { degreeStringToNote, parseKey } from './key.js';
import type { Form, FormBar, FormChord } from './parse.js';

/**
 * Return a copy of [form] with every chord's `root` (and slash `bass`) re-spelled
 * in [targetKey], from its stored `degree` / `bassDegree`. Throws if [targetKey]
 * isn't a valid key. Chords without a `degree` (e.g. no-key progressions) pass
 * through unchanged. The input form is not modified.
 *
 * @example
 * const { form } = parse(text);          // written in K:C
 * const inD = transposeFormToKey(form, 'D');
 */
export function transposeFormToKey(form: Form, targetKey: string): Form {
  const key = parseKey(targetKey);
  const bars: FormBar[] = form.bars.map((bar) => ({
    ...bar,
    chords: bar.chords.map((c) => transposeChord(c, key)),
  }));
  return { ...form, bars };
}

function transposeChord(c: FormChord, key: ReturnType<typeof parseKey>): FormChord {
  if (c.noChord) return c;
  const out: FormChord = { ...c };
  if (c.degree) {
    const root = degreeStringToNote(c.degree, key);
    if (root !== null) out.root = root;
  }
  if (c.bassDegree) {
    const bass = degreeStringToNote(c.bassDegree, key);
    if (bass !== null) out.bass = bass;
  }
  if (c.degree && out.root && out.type) {
    out.symbol = chordSymbol(out.root, out.type, out.bass ?? null);
    delete out.token;
  }
  return out;
}
