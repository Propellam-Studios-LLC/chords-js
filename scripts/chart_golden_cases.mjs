/**
 * The chart-renderer golden cases, shared by `test/chartSvg.test.ts` (which
 * renders them from `src/`) and `scripts/regen-golden.mjs --charts` (which
 * rewrites them from `dist/`). One list, so a case can never exist in the test
 * but not in the regenerator.
 *
 * Each case: `{ name, file | text, options }`. `file` is relative to
 * `test/fixtures/chart_corpus/`; the golden lands at
 * `test/fixtures/chart_golden/<name>.svg`.
 */

/** A long symbol in a deliberately narrow chart — the no-truncation case. */
export const LONG_SYMBOL_DOC = [
  '%chords-1.0',
  'T: Long Symbols',
  'M: 4/4',
  'L: 1/1',
  'K: Db',
  'Dbmaj7#11/Ab | Gbmaj7#11/Db Abm7b5/Gb | Db6/9 | Ebm7b5/2 Ab7b13/2 |]',
].join('\n');

/** `%%barnumbers` / `%%setbarnb` — the bar-number directive case. */
export const BARNUMBERS_DOC = [
  '%chords-1.0',
  '%%barnumbers 4',
  '%%setbarnb 9',
  'T: Bar Numbers',
  'M: 4/4',
  'L: 1/1',
  'K: F',
  'F | Bb | C7 | F |',
  'Dm7 | G7 | C7 | F |]',
].join('\n');

export const CHART_GOLDEN_CASES = [
  { name: 'blue_moon.letters-shorthand', file: 'blue_moon.chords', options: {} },
  {
    name: 'blue_moon.letters-classical',
    file: 'blue_moon.chords',
    options: { notation: 'classical' },
  },
  { name: 'blue_moon.roman', file: 'blue_moon.chords', options: { mode: 'roman' } },
  {
    name: 'lotus_blossom.letters-shorthand',
    file: 'lotus_blossom.chords',
    options: {},
  },
  {
    name: 'long_symbols.narrow-shorthand',
    text: LONG_SYMBOL_DOC,
    options: { width: 360 },
  },
  {
    name: 'long_symbols.narrow-classical',
    text: LONG_SYMBOL_DOC,
    options: { width: 360, notation: 'classical' },
  },
  { name: 'barnumbers.letters-shorthand', text: BARNUMBERS_DOC, options: {} },
  // The row-number gutter.
  {
    name: 'blue_moon.rownumbers',
    file: 'blue_moon.chords',
    options: { rowNumbers: true },
  },
];
