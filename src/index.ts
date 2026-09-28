/**
 * chords-js — a reference library for the `.chords` harmony format.
 *
 * Parse `.chords` text into a structured model, then transpose it, analyse it
 * in Roman numerals, render an iReal-style chord chart, compare two
 * progressions, or realize it as ABC notation (staff rendering and audio of
 * that ABC are left to abcjs). Chords can be written as absolute symbols
 * (`Cmaj7`, `G7/B`) or as Roman numerals relative to the key (`IVmaj7`, `V7`).
 *
 *   parse(text)                .chords text  -> headers + form (+ errors)
 *   validateChords(text)       .chords text  -> { errors, warnings, parsed }
 *   realizeChords(text)        .chords text  -> ABC (faithful: layout, parts, voltas)
 *   realizeForm(form, opts)    DbForm        -> ABC (playback path)
 *   transposeFormToKey(f, key) form          -> the form re-spelled in another key
 *   chartToSvg(text, opts)     .chords text  -> an SVG chord chart
 *   renderChart(el, text)      .chords text  -> that chart, in a DOM element
 *   compare(a, b)              two forms     -> harmonic + structural diff/score
 *   recognizeChord(pcs, key)   pitch classes -> a chord name in a key
 *   generateHarmonyPart(...)   melody + chords -> a generated harmony voice
 *
 * Lower-level building blocks (single-token parsers, key and degree helpers,
 * chart layout, comping patterns) are exported as well.
 */

export const VERSION = '0.1.0';

export {
  loadVocabulary,
} from './chordTypes.js';
export type { ChordType, ChordVocabulary } from './chordTypes.js';

export {
  parseChordToken,
  isNoChord,
  ChordParseError,
} from './parseChord.js';
export type { ParsedChord, NoChord } from './parseChord.js';

export {
  parseBody,
  classifyToken,
  repeatBrackets,
  BODY_TOKEN_RE,
  PART_RE,
} from './parseBody.js';
export type {
  BodyBar,
  ParsedBody,
  TokenKind,
  BarlineToken,
  FinalBarline,
} from './parseBody.js';

export { annotationToAbc, isAbcNavDecoration } from './annotations.js';

export {
  parseKey,
  noteToDegree,
  degreeForChord,
  romanFields,
  parseRomanDegree,
  degreeToNote,
  degreeStringToNote,
  KeyParseError,
} from './key.js';
export type { MusicKey, RomanFields, RomanDegree } from './key.js';

export { transposeFormToKey } from './transpose.js';

export {
  chartModel,
  chartModelFromText,
  chartToSvg,
  renderChart,
  renderChartFromForm,
  chartBarId,
  chartChordId,
  partsByChordLine,
  romanSymbol,
} from './chart.js';
export type {
  ChordChart,
  ChartLine,
  ChartBar,
  ChartChord,
  ChartSection,
  ChartMode,
  SymbolNotation,
  SymbolParts,
  RenderChartOptions,
  ChartRenderOptions,
  ChartRender,
} from './chart.js';

export { chartSvg, chartCss, layoutSymbol, symbolWidth, allocateLine } from './chartSvg.js';
export type { ChartSvgOptions } from './chartSvg.js';

export { splitSymbol, toGlyphs, qualityFor, symbolText } from './chartSymbolGlyphs.js';

export { advanceWidth, charAdvance } from './chartMetrics.js';

export { validateChords, flattenForm } from './validate.js';
export type {
  ChordsValidationResult,
  ValidateOptions,
  ParsedChords,
  FlatChord,
  DbFormFull,
  DbFormChordFull,
} from './validate.js';

export { compare } from './compare.js';
export type {
  CompareResult,
  CompareOptions,
  ChordMark,
  BarComparison,
  StructuralDiff,
} from './compare.js';

export { meterNumDen, lengthToFraction, MeterError } from './meter.js';

export { parse, parseStructure, buildForm } from './parse.js';
export type {
  ParseResult,
  Structure,
  Form,
  FormBar,
  FormChord,
} from './parse.js';

export { chordSymbol, displaySuffixFor } from './chordSymbol.js';

export {
  realizeChords,
  realizeForm,
  realizeFormBody,
  formToDbForm,
  chordTonePitchClasses,
  RealizeError,
  compingPatterns,
  boomChick,
  blockSustained,
  blockPerBeat,
  bassOnly,
  arpeggio,
  stabs,
} from './realize.js';
export type {
  DbForm,
  DbFormBar,
  DbFormChord,
  RealizeOptions,
  RealizeChordsOptions,
  CompingContext,
  CompingPattern,
  CompingPatternName,
  Note,
  Frac,
} from './realize.js';

export {
  romanBarsToAbsolute,
  absoluteBarsToRoman,
  romanChordsToSimpleBars,
} from './convertBars.js';
export type { SimpleChord, ConvertFailure, ConvertResult } from './convertBars.js';

// Roman numerals as input: parsed on a par with absolute symbols, and
// round-tripping with the Roman-numeral chart renderer.
export { parseRomanChordToken, romanSuffixToCanonical } from './romanToken.js';
export type { ParsedRomanChord } from './romanToken.js';
export { parseRomanBody } from './parseBody.js';
export type { RomanBodyBar, ParsedRomanBody } from './parseBody.js';

export { recognizeChord } from './recognize.js';
export type {
  RecognizeOptions,
  RecognizedChord,
  RecognizeFailure,
  RecognizeResult,
} from './recognize.js';

export {
  generateHarmonyPart,
  closeHarmonyScore,
  HarmonizeError,
} from './harmonize.js';
export type {
  HarmonyPart,
  HarmonizeOptions,
  HarmonizeResult,
  CloseHarmonyScoreOptions,
  CloseHarmonyScore,
} from './harmonize.js';
