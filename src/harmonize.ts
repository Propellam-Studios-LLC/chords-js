/**
 * Close-harmony part generation — computes a bluegrass close-harmony part
 * (tenor above / baritone below) from a single-voice ABC melody with embedded
 * chord symbols.
 *
 * Algorithm:
 *  - a melody note that IS a chord tone → the nearest chord tone strictly
 *    above (tenor) / below (baritone); chord tones are the symbol's
 *    interval pattern up to the 7th (extensions ignored);
 *  - a non-chord (passing/neighbor) tone → the diatonic third above/below
 *    in the key, so passing motion stays parallel;
 *  - a tie continuation holds the previous harmony pitch even across a
 *    chord change (never re-attack inside a melody tie);
 *  - pickup notes before the first chord symbol are harmonized against
 *    that first chord (it is already "in the air").
 *
 * The harmony line is produced by walking the melody token stream and
 * substituting each note's pitch while passing everything else through
 * verbatim — so barlines, repeats, voltas, slurs, ties, tuplet markers,
 * broken-rhythm signs and durations are inherited structurally rather
 * than re-derived. Accidental state is tracked per measure per voice
 * (ABC semantics: an explicit accidental binds letter+octave to the end
 * of the measure), so the emitted part carries minimal accidentals and
 * stays correct under any key signature.
 */

import { loadVocabulary } from './chordTypes.js';
import { MusicKey, parseKey } from './key.js';
import { ChordParseError, ParsedChord, isNoChord, parseChordToken } from './parseChord.js';

const LETTER_ORDER = 'CDEFGAB';
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACC_DELTA: Record<string, number> = { '^': 1, _: -1, '=': 0 };

/** Interval label → [diatonic degree, semitones above root]; degrees > 7
 * (extensions) are excluded from close-harmony chord tones. */
const INTERVAL_META: Record<string, [number, number]> = {
  '1': [1, 0], b2: [2, 1], '2': [2, 2], '#2': [2, 3], b3: [3, 3], '3': [3, 4],
  '4': [4, 5], '#4': [4, 6], b5: [5, 6], '5': [5, 7], '#5': [5, 8],
  b6: [6, 8], '6': [6, 9], bb7: [7, 9], b7: [7, 10], '7': [7, 11], maj7: [7, 11],
};

export type HarmonyPart = 'tenor' | 'baritone';

/** Which chord tone the `'chordTone'` mode holds. */
export type ChordToneChoice = 'root' | 'third' | 'fifth';

export interface HarmonizeOptions {
  part: HarmonyPart;
  /** 'harmony' (default): the moving close-harmony line. 'chordTone': ONE
   * held chord tone per chord region, below the melody, consecutive
   * same-pitch notes tied — a simple reference line to sing against. `part`
   * is ignored in chordTone mode (the voice is named ChordTone). */
  mode?: 'harmony' | 'chordTone';
  /** Chord tone to hold in chordTone mode (default 'root'). A chord
   * without the requested degree (e.g. sus chords for 'third') falls back
   * to its root. */
  tone?: ChordToneChoice;
}

export interface HarmonizeResult {
  /** Harmony music lines, one per melody music line (chords stripped). */
  partLines: string[];
  /** Combined two-voice ABC — both voices on ONE shared staff (the higher
   * voice is listed first so it takes stems-up), melody keeping its chords +
   * lyrics. */
  combinedAbc: string;
  /** The harmony part ALONE as a complete single-voice ABC, with the
   * melody's lyrics attached (identical rhythm ⇒ identical alignment), so
   * the part can be displayed and sung on its own. */
  partAbc: string;
  /** Non-fatal notes: pickup-before-first-chord, no chords at all, … */
  warnings: string[];
}

export class HarmonizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarmonizeError';
  }
}

interface SpelledPitch {
  letter: string;
  midi: number;
}

/** letter (all octaves) → key-signature accidental offset (−1, 0, +1). */
function keySignatureMap(key: MusicKey): Record<string, number> {
  const map: Record<string, number> = {};
  const tonicIdx = LETTER_ORDER.indexOf(key.tonicLetter);
  for (let d = 0; d < 7; d++) {
    const letter = LETTER_ORDER[(tonicIdx + d) % 7];
    const expected = (key.tonicPc + key.intervals[d]) % 12;
    let delta = expected - LETTER_PC[letter];
    if (delta > 6) delta -= 12;
    if (delta < -6) delta += 12;
    map[letter] = delta;
  }
  return map;
}

/** Chord tones (≤ 7th) as spelled pitch classes: letter + pc. */
function chordTonePcs(chord: ParsedChord): { letter: string; pc: number }[] {
  const vocab = loadVocabulary();
  const type = vocab.entryByCanonical.get(chord.canonical);
  if (!type) return [];
  const rootIdx = LETTER_ORDER.indexOf(chord.root);
  const rootAccDelta = chord.rootAcc === '#' ? 1 : chord.rootAcc === 'b' ? -1 : 0;
  const rootPc = (LETTER_PC[chord.root] + rootAccDelta + 12) % 12;
  const tones: { letter: string; pc: number }[] = [];
  for (const label of type.intervalPattern) {
    const meta = INTERVAL_META[label];
    if (!meta) continue; // extension — not a close-harmony target
    const [degree, semis] = meta;
    tones.push({
      letter: LETTER_ORDER[(rootIdx + degree - 1) % 7],
      pc: (rootPc + semis) % 12,
    });
  }
  return tones;
}

const CHORD_TONE_DEGREE: Record<ChordToneChoice, number> = {
  root: 1, third: 3, fifth: 5,
};

/** The spelled chord tone at the requested degree, or the root when the
 * chord lacks that degree (sus chords for 'third', b5-less voicings…). */
function chordToneForChoice(
  chord: ParsedChord,
  choice: ChordToneChoice,
): { letter: string; pc: number } {
  const vocab = loadVocabulary();
  const type = vocab.entryByCanonical.get(chord.canonical);
  const rootIdx = LETTER_ORDER.indexOf(chord.root);
  const rootAccDelta = chord.rootAcc === '#' ? 1 : chord.rootAcc === 'b' ? -1 : 0;
  const rootPc = (LETTER_PC[chord.root] + rootAccDelta + 12) % 12;
  const want = CHORD_TONE_DEGREE[choice];
  if (type) {
    for (const label of type.intervalPattern) {
      const meta = INTERVAL_META[label];
      if (!meta) continue;
      const [degree, semis] = meta;
      if (degree === want) {
        return {
          letter: LETTER_ORDER[(rootIdx + degree - 1) % 7],
          pc: (rootPc + semis) % 12,
        };
      }
    }
  }
  return { letter: chord.root, pc: rootPc };
}

/** Nearest chord tone strictly above/below `midi`, with its spelling. */
function nearestChordTone(
  midi: number,
  tones: { letter: string; pc: number }[],
  direction: 1 | -1,
): SpelledPitch {
  let best: SpelledPitch | null = null;
  for (const t of tones) {
    let m = midi + direction;
    while (((m % 12) + 12) % 12 !== t.pc) m += direction;
    if (!best || Math.abs(m - midi) < Math.abs(best.midi - midi)) {
      best = { letter: t.letter, midi: m };
    }
  }
  if (!best) throw new HarmonizeError('chord has no usable tones');
  return best;
}

/** Diatonic third above/below `midi` (spelled from the melody letter). */
function diatonicThird(
  melodyLetter: string,
  midi: number,
  keySig: Record<string, number>,
  direction: 1 | -1,
): SpelledPitch {
  const idx = LETTER_ORDER.indexOf(melodyLetter);
  const letter = LETTER_ORDER[(idx + direction * 2 + 7) % 7];
  const pc = (((LETTER_PC[letter] + keySig[letter]) % 12) + 12) % 12;
  let m = midi + direction;
  while (((m % 12) + 12) % 12 !== pc) m += direction;
  return { letter, midi: m };
}

/** ABC pitch body (case + octave marks, no accidental) for letter+midi. */
function abcPitchBody(letter: string, midi: number): string {
  // Octave of the spelled LETTER (a Cb5 is an octave-5 C even though its
  // sounding midi sits in octave 4).
  const natural = LETTER_PC[letter];
  let octave = Math.floor(midi / 12) - 1;
  const delta = midi - ((octave + 1) * 12 + natural);
  if (delta > 6) octave += 1;
  else if (delta < -6) octave -= 1;
  if (octave >= 5) return letter.toLowerCase() + "'".repeat(octave - 5);
  return letter.toUpperCase() + ','.repeat(4 - octave);
}

const NOTE_RE = /^([_^=]+)?([A-Ga-g])([,']*)((?:\d+)?(?:\/+\d*)?)/;
const REST_RE = /^([zZx])((?:\d+)?(?:\/+\d*)?)/;
const BARLINE_RE = /^(\[\||\|\]|\|\||::|:*\|+:*|\[[1-9](?:[,-][1-9])*)/;

/** Accidental-state key: letter+octave (ABC accidentals bind both). */
function stateKey(letter: string, octave: number): string {
  return letter + String(octave);
}

function octaveOf(letterAsWritten: string, marks: string): number {
  let octave = letterAsWritten === letterAsWritten.toLowerCase() ? 5 : 4;
  for (const c of marks) octave += c === "'" ? 1 : -1;
  return octave;
}

/** Emit a harmony note with the minimal accidental given key + measure state. */
function emitNote(
  pitch: SpelledPitch,
  duration: string,
  keySig: Record<string, number>,
  state: Map<string, number>,
): string {
  const body = abcPitchBody(pitch.letter, pitch.midi);
  const octave = octaveOf(body[0], body.slice(1));
  const natural = (octave + 1) * 12 + LETTER_PC[pitch.letter];
  const delta = pitch.midi - natural;
  const key = stateKey(pitch.letter, octave);
  const inForce = state.has(key) ? (state.get(key) as number) : keySig[pitch.letter];
  if (delta === inForce) return body + duration;
  state.set(key, delta);
  const sym = delta === 1 ? '^' : delta === -1 ? '_' : delta === 0 ? '=' : null;
  if (sym === null) {
    throw new HarmonizeError(
      `cannot spell harmony pitch midi ${pitch.midi} as ${pitch.letter}`);
  }
  return sym + body + duration;
}

interface HeaderInfo {
  headerLines: string[]; // through K: inclusive
  key: MusicKey;
  bodyStart: number; // index of first line after K:
}

/**
 * Drop an ABC inline comment from a header VALUE.
 *
 * The ABC spec treats everything after an unescaped `%` as a comment, and
 * abcjs honours that, so a header such as `K: Gm % key signature` must be read
 * as `Gm`; passing the raw value on would make key parsing throw
 * `KeyParseError`. `\%` is the spec's escape and is preserved.
 */
export function stripAbcComment(value: string): string {
  const m = /(^|[^\\])%/.exec(value);
  const cut = m === null ? value : value.slice(0, m.index + m[1].length);
  return cut.replace(/\\%/g, '%').trim();
}

function readHeaders(lines: string[]): HeaderInfo {
  for (let i = 0; i < lines.length; i++) {
    if (/^K:/.test(lines[i].trim())) {
      return {
        headerLines: lines.slice(0, i + 1),
        key: parseKey(stripAbcComment(lines[i].trim().slice(2))),
        bodyStart: i + 1,
      };
    }
  }
  throw new HarmonizeError('no K: header found');
}

function isMusicLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.startsWith('%')) return false;
  if (/^[A-Za-z]:/.test(t) && !t.startsWith('|')) return false; // w:, headers
  return true;
}

/** Try to read a chord out of one `"…"` annotation; null for text/non-chords. */
function chordFromAnnotation(symbol: string): ParsedChord | null | 'nc' {
  if (!/^[A-G]/.test(symbol)) return null;
  try {
    const parsed = parseChordToken(symbol, loadVocabulary());
    return isNoChord(parsed) ? 'nc' : parsed;
  } catch (e) {
    if (e instanceof ChordParseError) return null;
    throw e;
  }
}

/** One selected harmony note, mutable until emission (voice-leading pass). */
interface HarmonyNote {
  pitch: SpelledPitch;
  melodyMidi: number;
  duration: string;
  tieFromPrev: boolean;
  tieNext: boolean;
}

type HTok =
  | { kind: 'text'; text: string }
  | { kind: 'bar'; text: string }
  | { kind: 'note'; note: HarmonyNote };

/** Conservative voice-leading refinement: when the SAME harmony pitch
 * repeats 2+ times and then
 * moves by a third, the last repeat becomes the diatonic passing tone
 * toward the target (D D → B becomes D C → B — stepwise into the
 * resolution). Deliberately narrow — a boring-but-correct part beats an
 * adventurous-but-wrong one: never touches tied notes, only diatonic
 * steps, and the passing tone must stay on the part's side of the melody
 * with at least a minor third of clearance. The changed note must be no
 * longer than its predecessor — a passing tone held LONGER than the note it
 * steps from stops sounding like a passing tone (e.g. G G2 → B would sustain
 * a half-note ninth). */
/** Numeric value of an ABC duration suffix ('' = 1, '2' = 2, '/' = 0.5,
 * '3/2' = 1.5, '//' = 0.25). Broken-rhythm marks (`>`/`<`) are separate
 * tokens NOTE_RE never captures, so a `d>d` pair compares as equal —
 * acceptable: the sounding second note is the shorter of the two. */
function durationValue(d: string): number {
  const m = /^(\d+)?(?:(\/+)(\d+)?)?$/.exec(d);
  if (!m) return 1;
  let v = m[1] ? parseInt(m[1], 10) : 1;
  if (m[2]) v /= m[3] ? parseInt(m[3], 10) : 2 ** m[2].length;
  return v;
}

function refineVoiceLeading(
  notes: HarmonyNote[],
  keySig: Record<string, number>,
  direction: 1 | -1,
): void {
  for (let i = 1; i + 1 < notes.length; i++) {
    const cur = notes[i];
    const next = notes[i + 1];
    if (cur.tieFromPrev || cur.tieNext || next.tieFromPrev) continue;
    if (notes[i - 1].pitch.midi !== cur.pitch.midi) continue;
    if (durationValue(cur.duration) > durationValue(notes[i - 1].duration)) {
      continue;
    }
    const gap = next.pitch.midi - cur.pitch.midi;
    if (Math.abs(gap) < 3 || Math.abs(gap) > 4) continue; // exactly a third
    // The diatonic letter between the two, spelled from the key signature.
    const lo = gap > 0 ? cur.pitch : next.pitch;
    const midLetter = LETTER_ORDER[(LETTER_ORDER.indexOf(lo.letter) + 1) % 7];
    const pc = (((LETTER_PC[midLetter] + keySig[midLetter]) % 12) + 12) % 12;
    const hiMidi = Math.max(cur.pitch.midi, next.pitch.midi);
    let midi = Math.min(cur.pitch.midi, next.pitch.midi) + 1;
    while (midi < hiMidi && ((midi % 12) + 12) % 12 !== pc) midi++;
    if (midi >= hiMidi) continue; // no diatonic step strictly between
    // Stay on the part's side of the melody, with clearance.
    if (direction === 1 && midi <= cur.melodyMidi) continue;
    if (direction === -1 && midi >= cur.melodyMidi) continue;
    if (Math.abs(midi - cur.melodyMidi) < 3) continue;
    cur.pitch = { letter: midLetter, midi };
  }
}

/**
 * Generate the close-harmony part for a single-voice ABC melody with chord
 * symbols in `"…"` annotations (see the module overview for the algorithm).
 *
 * @param abcSource - One ABC tune: headers through `K:`, then the melody.
 * @param options - Which part to generate and in which mode.
 * @returns The part's lines, a combined two-voice tune, the part alone as a
 *   tune, and any warnings.
 * @throws {@link HarmonizeError} if the source has no `K:` header, already
 *   contains multiple voices, or a harmony note cannot be spelled.
 *
 * @example
 * const { partAbc } = generateHarmonyPart(abc, { part: 'tenor' });
 */
export function generateHarmonyPart(
  abcSource: string,
  options: HarmonizeOptions,
): HarmonizeResult {
  const mode = options.mode ?? 'harmony';
  const tone: ChordToneChoice = options.tone ?? 'root';
  const direction: 1 | -1 =
    mode === 'chordTone' ? -1 : options.part === 'tenor' ? 1 : -1;
  const lines = abcSource.replace(/\r\n/g, '\n').split('\n');
  const { headerLines, key, bodyStart } = readHeaders(lines);
  if (lines.some((l) => /^\s*V:/.test(l) || /\[V:/.test(l))) {
    throw new HarmonizeError('multi-voice ABC is not supported (melody + chords only)');
  }
  const keySig = keySignatureMap(key);
  const warnings: string[] = [];

  // Prescan for the first chord symbol — pickup notes before it are
  // harmonized against it (the chord is already "in the air").
  let chord: ParsedChord | null = null;
  let sawAnyChordToken = false;
  outer: for (let li = bodyStart; li < lines.length; li++) {
    if (!isMusicLine(lines[li])) continue;
    for (const m of lines[li].matchAll(/"([^"]*)"/g)) {
      const c = chordFromAnnotation(m[1].trim());
      if (c && c !== 'nc') { chord = c; break outer; }
    }
  }
  if (!chord) warnings.push('no chord symbols found — entire part is diatonic thirds');

  const partName =
    mode === 'chordTone'
      ? 'ChordTone'
      : options.part === 'tenor' ? 'Tenor' : 'Baritone';
  // Chord-tone mode holds one pitch per chord region; the region key marks
  // chord changes so a new tone is only picked when the chord changes.
  let regionKey: string | null = null;
  const melodyState = new Map<string, number>();
  let prevMelodyMidi: number | null = null;
  let prevHarmony: SpelledPitch | null = null;
  let tiePending = false;
  let notesBeforeFirstChordToken = 0;

  // Phase 1 — SELECT: walk the melody token stream, choosing each harmony
  // pitch but deferring text emission (the voice-leading pass may still
  // adjust pitches; accidentals depend on final pitches + measure order).
  interface SourceEntry {
    kind: 'music' | 'other';
    line: string;
    ridesMelody?: boolean;
  }
  const sourceEntries: SourceEntry[] = [];
  const lineToks: HTok[][] = [];
  const allNotes: HarmonyNote[] = [];
  // w: lines gathered per music line, so partAbc can re-attach the melody's
  // lyrics under the harmony lines (note-for-note identical rhythm).
  const lyricsPerLine: string[][] = [];

  for (let li = bodyStart; li < lines.length; li++) {
    const line = lines[li];
    if (!isMusicLine(line)) {
      const t = line.trim();
      const ridesMelody = /^[wW]:/.test(t) || t.startsWith('%');
      if (/^[wW]:/.test(t) && lyricsPerLine.length > 0) {
        lyricsPerLine[lyricsPerLine.length - 1].push(line);
      }
      sourceEntries.push({ kind: 'other', line, ridesMelody });
      continue;
    }
    const out: HTok[] = [];
    let i = 0;
    while (i < line.length) {
      const rest = line.slice(i);
      let m: RegExpExecArray | null;
      if (rest[0] === '"') {
        const end = rest.indexOf('"', 1);
        if (end === -1) { out.push({ kind: 'text', text: rest }); break; }
        const c = chordFromAnnotation(rest.slice(1, end).trim());
        if (c === 'nc') chord = null;
        else if (c) { chord = c; sawAnyChordToken = true; }
        i += end + 1; // annotations are NOT copied into the harmony line
        continue;
      }
      if (rest[0] === '{' || rest[0] === '!') {
        const close = rest[0] === '{' ? '}' : '!';
        const end = rest.indexOf(close, 1);
        const span = end === -1 ? rest : rest.slice(0, end + 1);
        out.push({ kind: 'text', text: span }); // graces/decorations verbatim
        i += span.length;
        continue;
      }
      if (rest[0] === '%') { out.push({ kind: 'text', text: rest }); break; }
      if ((m = BARLINE_RE.exec(rest)) !== null) {
        out.push({ kind: 'bar', text: m[0] });
        melodyState.clear();
        i += m[0].length;
        continue;
      }
      if ((m = NOTE_RE.exec(rest)) !== null) {
        const [tok, accs, letterRaw, octMarks, duration] = m;
        const letter = letterRaw.toUpperCase();
        const octave = octaveOf(letterRaw, octMarks);
        const natural = (octave + 1) * 12 + LETTER_PC[letter];
        const sKey = stateKey(letter, octave);
        let delta: number;
        if (accs) {
          delta = [...accs].reduce((a, c) => a + ACC_DELTA[c], 0);
          melodyState.set(sKey, delta);
        } else {
          delta = melodyState.has(sKey)
            ? (melodyState.get(sKey) as number)
            : keySig[letter];
        }
        const melody: SpelledPitch = { letter, midi: natural + delta };
        if (!sawAnyChordToken && chord) notesBeforeFirstChordToken++;

        const isTieContinuation =
          tiePending && prevMelodyMidi === melody.midi && prevHarmony !== null;
        let pitch: SpelledPitch;
        let holdsPrev = false;
        if (mode === 'chordTone') {
          const ctKey: string | null = chord
            ? chord.root + (chord.rootAcc ?? '') + chord.canonical
            : regionKey; // an 'nc' region keeps holding the previous tone
          if (prevHarmony !== null && ctKey === regionKey) {
            pitch = prevHarmony;
            holdsPrev = true;
          } else if (chord) {
            pitch = nearestChordTone(
              melody.midi, [chordToneForChoice(chord, tone)], -1);
          } else if (prevHarmony !== null) {
            pitch = prevHarmony;
            holdsPrev = true;
          } else {
            pitch = diatonicThird(melody.letter, melody.midi, keySig, -1);
          }
          regionKey = ctKey;
        } else if (isTieContinuation) {
          pitch = prevHarmony as SpelledPitch;
        } else if (chord) {
          const tones = chordTonePcs(chord);
          const melodyPc = ((melody.midi % 12) + 12) % 12;
          pitch = tones.some((t) => t.pc === melodyPc)
            ? nearestChordTone(melody.midi, tones, direction)
            : diatonicThird(melody.letter, melody.midi, keySig, direction);
        } else {
          pitch = diatonicThird(melody.letter, melody.midi, keySig, direction);
        }
        const note: HarmonyNote = {
          pitch,
          melodyMidi: melody.midi,
          duration,
          tieFromPrev: isTieContinuation,
          tieNext: false,
        };
        if ((isTieContinuation || (holdsPrev && mode === 'chordTone')) &&
            allNotes.length > 0) {
          allNotes[allNotes.length - 1].tieNext = true;
          note.tieFromPrev = true;
        }
        allNotes.push(note);
        out.push({ kind: 'note', note });
        prevHarmony = pitch;
        prevMelodyMidi = melody.midi;
        tiePending = false;
        i += tok.length;
        continue;
      }
      if ((m = REST_RE.exec(rest)) !== null) {
        out.push({ kind: 'text', text: m[0] });
        i += m[0].length;
        continue;
      }
      if (rest[0] === '-') {
        tiePending = true;
        out.push({ kind: 'text', text: '-' });
        i += 1;
        continue;
      }
      if (/^\(\d/.test(rest)) {
        out.push({ kind: 'text', text: rest.slice(0, 2) });
        i += 2;
        continue;
      }
      out.push({ kind: 'text', text: rest[0] }); // slurs, > <, spaces, dots, …
      i += 1;
    }
    lineToks.push(out);
    lyricsPerLine.push([]);
    sourceEntries.push({ kind: 'music', line });
  }

  // Phase 2 — REFINE: the conservative voice-leading pass. Chord-tone mode
  // is a deliberate drone — no refinement.
  if (mode !== 'chordTone') refineVoiceLeading(allNotes, keySig, direction);

  // Phase 3 — EMIT: final pitches → ABC with minimal accidentals (one
  // measure state carried across lines, reset at every barline).
  const emitState = new Map<string, number>();
  const partLines = lineToks.map((toks) =>
    toks
      .map((t) => {
        if (t.kind === 'bar') {
          emitState.clear();
          return t.text;
        }
        if (t.kind === 'note') {
          const emitted =
            emitNote(t.note.pitch, t.note.duration, keySig, emitState);
          // Chord-tone mode ties same-pitch repeats itself into a held tone.
          return mode === 'chordTone' && t.note.tieNext
              ? emitted + '-'
              : emitted;
        }
        // The melody's own tie dashes don't apply to the held tone.
        if (mode === 'chordTone' && t.text === '-') return '';
        return t.text;
      })
      .join('')
      .replace(/ {2,}/g, ' ')
      .trim());

  // Assemble the combined body: harmony line flushed AFTER its melody
  // line's w: lyrics; a blank line (which terminates an ABC tune) must
  // come after the pending harmony line, not strand it outside the body.
  const combinedBody: string[] = [];
  let pendingHrm: string | null = null;
  let mi = 0;
  for (const entry of sourceEntries) {
    if (entry.kind === 'other') {
      if (!entry.ridesMelody && pendingHrm !== null) {
        combinedBody.push(pendingHrm);
        pendingHrm = null;
      }
      combinedBody.push(entry.line);
      continue;
    }
    if (pendingHrm !== null) combinedBody.push(pendingHrm);
    combinedBody.push(`[V: Melody] ${entry.line}`);
    pendingHrm = `[V: ${partName}] ${partLines[mi++]}`;
  }
  if (pendingHrm !== null) combinedBody.push(pendingHrm);

  if (notesBeforeFirstChordToken > 0) {
    warnings.push(
      `${notesBeforeFirstChordToken} pickup note(s) before the first chord ` +
      'symbol were harmonized against that first chord');
  }

  const kIndex = headerLines.length - 1;
  // One SHARED staff (`%%staves (a b)`): the higher voice listed first takes
  // stems-up — tenor above the melody, baritone below it. V: declaration
  // order stays Melody-first so that in audio playback the melody is
  // track 0.
  //
  // NOTE: this output keeps its lyrics on the melody line even when the
  // melody is the SECOND voice of the shared stave (the tenor case), so abcjs
  // pushes the lyric row down by one — see the long note in
  // closeHarmonyScore, which attaches the w: lines to the first-written voice
  // to avoid this. `combinedAbc` is meant as a quick preview; use
  // closeHarmonyScore for display-quality output.
  const stavesOrder =
    direction === 1 ? `${partName} Melody` : `Melody ${partName}`;
  const combinedAbc = [
    ...headerLines.slice(0, kIndex),
    `%%staves (${stavesOrder})`,
    'V: Melody',
    `V: ${partName}`,
    headerLines[kIndex],
    ...combinedBody,
  ].join('\n');

  const partBody: string[] = [];
  partLines.forEach((l, i) => {
    partBody.push(l);
    for (const w of lyricsPerLine[i] ?? []) partBody.push(w);
  });
  const partAbc = [...headerLines, ...partBody].join('\n');

  return { partLines, combinedAbc, partAbc, warnings };
}

/** Options for [closeHarmonyScore] — an arbitrary voice combination. */
export interface CloseHarmonyScoreOptions {
  /** Which computed harmony parts to include (either, both, or none). */
  parts: HarmonyPart[];
  /** Include the held chord-tone reference voice (root/third/fifth per
   * chord region, below the melody). Omit for none. */
  chordTone?: ChordToneChoice;
  /** Include the melody voice (default true). */
  includeMelody?: boolean;
  /** true (default): all voices on ONE shared staff (`%%staves (a b c)`);
   * false: one staff per voice. */
  sharedStaff?: boolean;
}

export interface CloseHarmonyScore {
  abc: string;
  warnings: string[];
}

/** Assemble a close-harmony SCORE for any voice combination — melody,
 * tenor, baritone in fixed top-down register order (Tenor, Melody,
 * Baritone) — with the staff layout the caller chose. Lyrics ride the
 * melody when present, else the top-most included part (identical rhythm
 * ⇒ identical alignment) — except on a shared staff, where they ride
 * whichever voice is written first, because abcjs offsets a lyric row by its
 * voice's index on the stave (see the note at the emission site); chord
 * symbols stay with the melody. A single selected voice is emitted as a plain
 * single-voice tune.
 *
 * @throws {@link HarmonizeError} if no voice is selected, or for the same
 *   input problems as {@link generateHarmonyPart}. */
export function closeHarmonyScore(
  abcSource: string,
  options: CloseHarmonyScoreOptions,
): CloseHarmonyScore {
  const parts = options.parts ?? [];
  const includeMelody = options.includeMelody !== false;
  const sharedStaff = options.sharedStaff !== false;
  if (!parts.length && !includeMelody && !options.chordTone) {
    throw new HarmonizeError('select at least one voice');
  }
  const lines = abcSource.replace(/\r\n/g, '\n').split('\n');
  const { headerLines, bodyStart } = readHeaders(lines);

  // Melody music lines + their w: lyric lines, straight from the source.
  const musicLines: string[] = [];
  const lyricsPerLine: string[][] = [];
  for (let li = bodyStart; li < lines.length; li++) {
    const line = lines[li];
    if (isMusicLine(line)) {
      musicLines.push(line);
      lyricsPerLine.push([]);
    } else if (/^\s*[wW]:/.test(line) && musicLines.length) {
      lyricsPerLine[musicLines.length - 1].push(line);
    }
  }

  const warnings: string[] = [];
  const partLinesByPart = new Map<HarmonyPart, string[]>();
  for (const p of parts) {
    const r = generateHarmonyPart(abcSource, { part: p });
    partLinesByPart.set(p, r.partLines);
    for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
  }

  const voices: { id: string; lines: string[] }[] = [];
  if (parts.includes('tenor')) {
    voices.push({ id: 'Tenor', lines: partLinesByPart.get('tenor') as string[] });
  }
  if (includeMelody) voices.push({ id: 'Melody', lines: musicLines });
  if (parts.includes('baritone')) {
    voices.push({ id: 'Baritone', lines: partLinesByPart.get('baritone') as string[] });
  }
  if (options.chordTone) {
    const r = generateHarmonyPart(abcSource, {
      part: 'baritone', mode: 'chordTone', tone: options.chordTone,
    });
    for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
    voices.push({ id: 'ChordTone', lines: r.partLines });
  }
  const carrier = includeMelody ? 'Melody' : voices[0].id;

  if (voices.length === 1) {
    const v = voices[0];
    const body: string[] = [];
    v.lines.forEach((l, i) => {
      body.push(l);
      for (const w of lyricsPerLine[i] ?? []) body.push(w);
    });
    return { abc: [...headerLines, ...body].join('\n'), warnings };
  }

  const ids = voices.map((v) => v.id);
  const kIndex = headerLines.length - 1;
  const out = [
    ...headerLines.slice(0, kIndex),
    sharedStaff ? `%%staves (${ids.join(' ')})` : `%%staves ${ids.join(' ')}`,
    ...ids.map((id) => `V: ${id}`),
    headerLines[kIndex],
  ];
  // Which voice the `w:` lines are attached to.
  //
  // Split layout: the carrier (the melody, normally), so the words sit under
  // the staff whose notes they belong to.
  //
  // Shared staff: the FIRST voice, even when that is not the carrier. abcjs
  // offsets a lyric row downward by its voice's index ON THE STAVE —
  // `child.pitch -= child.voiceNumber * child.lyricHeightBelow` in
  // write/layout/set-upper-and-lower-elements.js, whose own TODO notes it
  // "can result in extra unused vertical space if there are lyrics only on the
  // second but not the first voice". That is exactly our case: with
  // `%%staves (Tenor Melody)` the melody is voice 1, so its words would be
  // pushed a full lyric row below the staff to make room for voice 0 lyrics
  // that do not exist — detaching the words from their system and shunting
  // the next system's chord symbols and S:/N: credit lines downward. Every
  // voice here is generated note-for-note from the melody, so the syllables
  // align identically whichever of them carries them; on one shared staff the
  // words land in the same place either way. Split layout is unaffected —
  // there each voice is voice 0 of its own stave, so no offset applies and
  // the carrier attachment is what puts the words under the melody.
  const lyricVoice = sharedStaff ? voices[0].id : carrier;
  musicLines.forEach((_, i) => {
    for (const v of voices) {
      out.push(`[V: ${v.id}] ${v.lines[i]}`);
      if (v.id === lyricVoice) {
        for (const w of lyricsPerLine[i] ?? []) out.push(w);
      }
    }
  });
  return { abc: out.join('\n'), warnings };
}
