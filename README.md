# chords-js

A reference library for the **`.chords`** harmony format. A `.chords` file is a
plain-text chord progression written in the style of ABC notation: ABC-like
headers (title, meter, key), then bars of chord symbols such as `Dm7 | G7 | Cmaj7`.
The format is specified at
**[propellamstudios.com/software/chords-format](https://propellamstudios.com/software/chords-format/)**.

`chords-js` parses `.chords` into a structured model and provides modules to
render chord charts, transpose, do Roman-numeral analysis, compare/score
progressions, and convert to ABC for staff notation and playback with abcjs.

## Install

```bash
npm install chords-js
```

ESM (`import`) and CommonJS (`require`) are both supported, with TypeScript
types included. Node 18 or later, or any modern browser. `abcjs` is only needed
if you want to render the realized ABC as staff notation or audio.

## What it is (and isn't)

`.chords` is a small, ASCII, ABC-shaped format for **harmony** — it standardizes
the chord-quality vocabulary that ABC notation deliberately leaves
implementation-defined. `chords-js` is to `.chords` what
[abcjs](https://abcjs.net) is to ABC: the reference implementation that makes the
format *useful*, not just *specified*.

**It complements abcjs — it does not reimplement it.** Staff notation and audio
playback are delegated to abcjs by transpiling `.chords` → ABC. `chords-js` owns
only the chord-specific layer abcjs can't do:

| Capability | Owner |
|---|---|
| Parse `.chords` (headers, bars, repeats, voltas, fractions, multi-chord bars) | **chords-js** |
| **Chord-chart** model + optional built-in render (letters / Roman grid) | **chords-js** |
| **Transpose** chord *symbols* (not just notes) | **chords-js** |
| **Roman-numeral** analysis | **chords-js** |
| **Compare / score** two progressions | **chords-js** |
| `.chords` → ABC bridge | **chords-js** |
| Staff notation render · audio synthesis | **abcjs** (via the bridge) |

`abcjs` is an **optional peer dependency** — only needed for the staff/audio
handoff. Parse / transpose / Roman / chart / compare work without it.

## Usage

```ts
import {
  parse, realizeForm, formToDbForm, transposeFormToKey,
  renderChart, renderChartFromForm, chartToSvg, chartModel, compingPatterns,
} from 'chords-js';

const text = `%chords-1.0
M: 4/4
L: 1/1
K: C
|: Dm7 | G7 :| C | F |]`;

const { form, headers, title } = parse(text);   // → structured model (below)

// Chord chart — the library RENDERS it, the way abcjs renders notation.
renderChart('paper', text);                              // → SVG in the element
renderChart('paper', text, { notation: 'classical' });   // full quality text
renderChart('paper', text, { mode: 'roman' });           // Roman degrees
const { svg } = chartToSvg(text, { width: 720 });        // DOM-free (Node, CLI)
renderChartFromForm('paper', form);                      // from a stored form
const model = chartModel(form, { mode: 'letters' });     // model only, render it yourself

// Transpose by re-spelling each chord's stored Roman degree into a new key.
const inG = transposeFormToKey(form, 'G');

// Realize to ABC for the abcjs staff/audio handoff (default boom-chick comping).
const abc = realizeForm(formToDbForm(form), { key: 'C', timeSignature: '4/4' });
const arp = realizeForm(formToDbForm(form), {
  key: 'C', timeSignature: '4/4', comping: compingPatterns.arpeggio,
});

// Compare two progressions: harmonic (per-written-bar, weighted partial credit,
// key-independent by default) + a light structural diff.
import { compare } from 'chords-js';
const { harmonicScore01, identical, structural } = compare(form, inG);
// → identical: true (same Roman progression, different key)
```

### The `form` (what `parse()` returns)

`parse(text)` returns `{ version, id, headers, directives, title, composer,
canonicalKey, hasFixedKey, meter, form, errors }`. The **`form`** is the structure-preserving
model everything else consumes — render your own chart/UI straight from it:

```ts
interface Form {
  bars: FormBar[];
  finalBarline: 'final' | 'repeatClose';   // how the progression ends (|] or :|)
}
interface FormBar {
  bar: number;                // 1-based
  volta: number | null;       // 1st/2nd-ending number on this bar
  annotations: string[];
  chords: FormChord[];
  line?: number;              // 0-based authored body line this bar sits on
  leadingBarline?: 'none' | 'plain' | 'repeatOpen' | 'repeatClose' | 'repeatBoth';
                              // the barline that opens this bar: the repeat structure
}
interface FormChord {
  token?: string;             // the raw token as written, incl. duration (e.g. "Am7/2")
  symbol?: string;            // chord symbol, e.g. "Cm7", "G7/B" (re-spelled by transpose)
  root?: string;              // absolute incl. accidental, e.g. "C", "Bb", "F#"
  type: string | null;        // canonical quality, e.g. "min7"; null for N.C.
  bass?: string;              // slash bass, e.g. "B"
  degree?: string | null;     // key-aware Roman degree, e.g. "ii", "V", "bVII"
  bassDegree?: string;
  units: number;              // duration in L: units
  beat: number;               // 1-based beat within the bar
  noChord?: true;             // N.C.
}
```

### The chart renderer

`chords-js` owns chart rendering the way abcjs owns notation rendering: hand it
`.chords` text and an element, get an **SVG** chart. Nothing measures text
through a DOM, so the same input produces the same bytes in Node and in a
browser (which is what makes the goldens in `test/chartSvg.test.ts` possible).

Conventions, from iReal Pro:

- **Duration is geometry, never text.** A chord's `units` becomes its share of
  the bar cell — `Ebmaj7/2 Cm7/2` sits in the cell's two halves, a 2/3 + 1/3 bar
  at 1/3 and 5/6. No `/2` ever reaches the page.
- **Symbols are typeset**: a large root, the quality set smaller and raised,
  alterations smaller still and stacked, real ♭/♯ glyphs.
- **Structure is drawn**: repeat barlines with dots, volta ending brackets,
  boxed `P:` section labels, segno/coda glyphs.
- **A chord symbol is NEVER truncated.** Overflow is resolved by widening the
  bar cell, then scaling the line, then scaling that one symbol. There is no
  ellipsis in this renderer.

Two independent axes:

| option | values |
|---|---|
| `mode` | `letters` (absolute) · `roman` (degrees — always spelled classically) |
| `notation` | `shorthand` (iReal Pro: `△`, `ø7`, `°7`, `-7`) · `classical` (`maj7`, `m7♭5`, `dim7`, `m7`) |

`%%barnumbers N` and `%%setbarnb N` in the document print measure numbers every
N bars. (ABC-style `%%directives` survive parsing and reach `parse().directives`
whether or not the chart understands them.)

#### Addressable hooks

Every element is addressable, so a host colours, tints and taps the chart
**without re-rendering** — the same way an app drives per-notehead colouring on
abcjs output.

```
<svg class="cc-chart cc-chart--letters cc-chart--shorthand" data-bars="26" data-lines="7">
  <style>…CSS variables…</style>
  <g class="cc-section" data-section="A">
    <rect class="cc-part-box"/><text class="cc-part">A</text>
    <g class="cc-line" data-line="0" data-first-bar="0">
      <path class="cc-barline cc-barline--repeatOpen"/><circle class="cc-repeat-dot"/>
      <g class="cc-bar" id="cc-bar-0" data-bar="0" data-measure="1">
        <rect class="cc-bar-hit"/>                       <!-- tap target -->
        <g class="cc-chord" id="cc-chord-0-0" data-bar="0" data-slot="0" data-units="0.5">
          <text class="cc-sym">
            <tspan class="cc-root">E♭</tspan><tspan class="cc-qual">△</tspan>
          </text>
        </g>
      </g>
      <g class="cc-volta" data-volta="1" data-from-bar="6" data-to-bar="7">…</g>
    </g>
  </g>
</svg>
```

- **Ids are index-based and stable**, in the chart's **written** bar order:
  `cc-bar-{bar}` / `cc-chord-{bar}-{slot}`. Build them with `chartBarId(bar)` /
  `chartChordId(bar, slot)`, never by hand. Letters and Roman emit the *same* id
  set, so a vocabulary toggle keeps a host's overlay.
- **State classes** a host adds/removes on `.cc-chord` / `.cc-bar` / `.cc-line`
  (the renderer never sets them; the stylesheet defines them): `is-correct` ·
  `is-wrong` · `is-missed` · `is-active` · `is-active-row` · `is-dim` ·
  `is-selected` (the selection colour, deliberately distinct from the others).
- **Theming is CSS variables** — `--cc-ink`, `--cc-line`, `--cc-part`,
  `--cc-volta`, `--cc-annot`, `--cc-correct`, `--cc-wrong`, `--cc-missed`,
  `--cc-active-tint`, `--cc-active-ink`. Set them on the `<svg>` or any ancestor.
  The default stylesheet is embedded (`embedCss`, on by default) and ships a
  `prefers-color-scheme: dark` block. Custom properties reach **inline** SVG;
  they do not reach an `<img src="data:…">`, so the contract is *inline this SVG*.
- Ids are unique per SVG. Two charts on one page are fine — scope with
  `element.querySelector(…)`, never `document.getElementById`.

### The chart model (what `chartModel()` returns)

If you'd rather render it yourself:

```ts
interface ChordChart {
  mode: 'letters' | 'roman';
  notation: 'shorthand' | 'classical';
  sections: ChartSection[];   // one per P: run
  lines: ChartLine[];         // the same lines, flattened
  barCount: number;
  barNumbers: number | null;  // %%barnumbers
}
interface ChartSection { part: string | null; lines: ChartLine[]; }
interface ChartLine { index: number; bars: ChartBar[]; }
interface ChartBar {
  index: number;              // flat WRITTEN bar order — what host ids key on
  number: number;             // printed measure number
  symbols: string[];          // ['Cm7'] or ['ii7','V7'] or ['N.C.']
  chords: ChartChord[];
  openRepeat: boolean;        // draw |: on the leading barline
  closeRepeat: boolean;       // draw :| on the trailing barline
  leadingBarline: BarlineToken;
  closingBarline: BarlineToken | FinalBarline;
  volta: number | null;
  part: string | null;
  annotations: string[];
  line: number;
}
interface ChartChord {
  label: string;              // 'E♭△' — no duration suffix, ever
  parts: SymbolParts;         // { root, quality, alterations[], bass } for typesetting
  units: number;
  weight: number;             // share of the bar
  offset: number;             // cumulative share before this chord
  index: number;              // slot index
}
```

## Roman-numeral vocabulary

Roman-numeral chords are **canonical input vocabulary**, first class beside the
absolute symbols. The
library used to know them only as *output*; now `parseRomanChordToken` /
`parseRomanBody` read back exactly what `romanSymbol` /
`absoluteBarsToRoman` write.

```
romanToken   := accidental* numeral suffix? bassPart? durationTail?
accidental   := 'b' | '#'
numeral      := 'I'|'II'|'III'|'IV'|'V'|'VI'|'VII'   (major-family)
              | 'i'|'ii'|'iii'|'iv'|'v'|'vi'|'vii'   (minor-family)
suffix       := any alias or display spelling of a chord type in chord_types.json
bassPart     := '/' accidental* numeral              (slash bass; normalised uppercase)
durationTail := the ordinary `.chords` duration syntax ('/2', '4', '3/2')
```

```js
import { parseRomanBody, romanChordsToSimpleBars, romanBarsToAbsolute } from 'chords-js';

const body = parseRomanBody('|: i | bVII | IV | V7 :|');
const bars = romanChordsToSimpleBars(body.bars);
romanBarsToAbsolute(bars, 'Eb').bars; // Ebm, Db, Ab, Bb7
```

`parseRomanBody` takes **no key** — Roman is key-independent by design, and the
degrees are the answer. Its bar/repeat/volta/annotation structure is identical
to `parseBody`'s (it is the same walker), so a consumer's envelope needs no
change.

### Case carries the triad quality

UPPERCASE is major-family, lowercase is minor-family — the same thing the
Roman *renderer* means.
Because the renderer drops a leading `m` from a `min*` suffix (the numeral
already said minor), a bare `7` resolves differently on the two cases:

| token | means | token | means |
|---|---|---|---|
| `V7` | dominant seventh | `ii7` | minor seventh |
| `Imaj7` | major seventh | `iimaj7` | minor-major seventh |
| `III+` / `IIIaug` | augmented | `viio` / `viio7` | diminished / diminished seventh |
| `IV6` | major sixth | `ii6` | minor sixth |
| `bVII` | flat-seven major | `#iv` | sharp-four minor |

`+` and `o` come for free — they are already aliases of `aug` and `dim` in
`chord_types.json`.

**Case and suffix must agree.** `Im7` is rejected, not silently normalised, and
the error names the spelling you probably meant:

```
'Im7': the numeral 'I' is uppercase, which means a major-family triad, but the
quality 'm7' is min7 — you may have meant 'i7'
```

A *suspended* chord has no third, so its case carries no information and both
`Isus4` and `isus4` are accepted.

### Two false friends, documented because they cannot be detected

1. **`/X` after a numeral is a slash BASS, not a secondary dominant.** `V/V` is
   "V with scale-degree 5 in the bass". That is what `romanSymbol` already
   emits (`V7/I`), and round-tripping with the library's own output takes
   priority. **Secondary dominants / tonicization have no notation in this
   vocabulary** and cannot be flagged as an error — the token parses, just not
   as a classically-trained musician might intend. Consumers must say so in
   their input helper text. (Extending the vocabulary to support them is
   tracked separately.)
2. **An arabic suffix is a chord TYPE, not figured bass.** `IV6` is a major
   sixth chord, exactly as `C6` is; a trailing number after a complete symbol
   is a duration, exactly as in the absolute vocabulary (`V64` = a `V6` lasting
   four units, just as `C64` = a `C6` lasting four units). **Inversions are
   written as slash bass**: `I/III`, `IV/VI`, `V7/II` — prefer that idiom
   prominently in any UI helper text, because it is the first thing a
   classically-trained user will look for.

## The `.chords` format, in brief

A short summary; the full specification is at
[propellamstudios.com/software/chords-format](https://propellamstudios.com/software/chords-format/).

A `.chords` file is ABC-shaped: a version line, ABC-style headers, then a body of
bars.

```
%chords-1.0
T: Autumn Leaves          title (optional)
C: Joseph Kosma           composer (optional)
M: 4/4                    meter (required)
L: 1/1                    unit length: a bare chord lasts one L: unit (required)
K: Gm                     key (required for Roman analysis and transposition)
P:A                       a part/section label (optional)
|: Cm7 | F7 | Bbmaj7 | Ebmaj7 |
Am7b5 | D7b13 | Gm6/2 Gb7/2 | Gm6 :|]
```

- **Bars** are separated by `|`. Repeats: `|:` … `:|` (and `::`). The final
  barline is `|]`. Voltas: `[1` / `[2` (or `|1` / `:|2`).
- **Chords** are a root (`A`–`G`, optional `#`/`b`), a quality from the built-in
  vocabulary (`m7`, `maj7`, `7`, `m7b5`, `dim7`, `sus4`, …), an optional slash
  bass (`/B`), and an optional duration in `L:` units (`C/2` = half a unit,
  `C2` = two).
- `N.C.` is a no-chord. `"quoted text"` is an annotation. Lines starting `%` are
  comments.
- Roman-numeral chords (below) are accepted in place of absolute symbols.

`validateChords(text)` reports exactly what a file breaks.

## Why it exists

It's a single TypeScript source of truth for `.chords` logic, for:

- apps that play, display or teach chord progressions (in the browser, or in a
  mobile WebView),
- content pipelines that validate and convert `.chords` files (from Node), and
- anyone who wants chord charts that transpose correctly.

## Develop

```bash
npm install
npm run build   # rollup → dist/{index.esm.js,index.cjs} + tsc declarations
npm test        # vitest
```

## Test fixtures

Two of the test charts (`test/fixtures/chart_corpus/blue_moon.chords` and
`lotus_blossom.chords`) are derived from the iRb corpus (Shanahan & Broze,
2012), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/);
each file's `S:` line carries the attribution.

## License

MIT © 2026 Propellam Studios LLC. See [LICENSE](./LICENSE).
