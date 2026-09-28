// Regenerate the goldens from the current chords-js output. Run after an
// INTENDED change, and read the diff.
//
//   npm run build && node scripts/regen-golden.mjs            # validator goldens
//   npm run build && node scripts/regen-golden.mjs --charts   # chart SVG goldens
//
// Both read `dist/`, so the build has to be current.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chartToSvg, validateChords } from '../dist/index.esm.js';
import { CHART_GOLDEN_CASES } from './chart_golden_cases.mjs';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--charts')) {
  const corpus = resolve(base, 'test/fixtures/chart_corpus');
  const out = resolve(base, 'test/fixtures/chart_golden');
  for (const c of CHART_GOLDEN_CASES) {
    const text = c.text ?? readFileSync(resolve(corpus, c.file), 'utf8');
    const { svg } = chartToSvg(text, c.options);
    writeFileSync(resolve(out, `${c.name}.svg`), svg);
  }
  console.log(`regenerated ${CHART_GOLDEN_CASES.length} chart goldens`);
  process.exit(0);
}

const corpus = resolve(base, 'test/fixtures/chords_corpus');
const names = readdirSync(corpus)
  .filter((f) => f.endsWith('.chords') && !f.startsWith('_'))
  .map((f) => f.slice(0, -'.chords'.length))
  .sort();

const golden = {};
for (const name of names) {
  const r = validateChords(readFileSync(resolve(corpus, `${name}.chords`), 'utf8'));
  golden[name] = { errors: r.errors, warnings: r.warnings ?? [], parsed: r.parsed ?? null };
}
writeFileSync(
  resolve(base, 'test/fixtures/validate_golden.json'),
  JSON.stringify(golden, null, 2) + '\n',
);
console.log(`regenerated ${names.length} golden entries`);
