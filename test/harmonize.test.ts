import { describe, expect, it } from 'vitest';
import abcjs from 'abcjs';
import { closeHarmonyScore, generateHarmonyPart, HarmonizeError, stripAbcComment } from '../src/harmonize.js';

/**
 * Golden tests for the harmony-part generator. The All the Good Times
 * expectations were hand-derived note by note (K:G, chords G/C/D):
 * chord tones take the nearest chord tone strictly above (tenor) / below
 * (baritone); passing tones take the diatonic third; ties hold pitch.
 */

const ALL_THE_GOOD_TIMES = `X: 1
T: All the Good Times
M: 3/4
L: 1/4
R: song
Q:1/4=92
K: G
|:G | "G" B2 B/A/ | G2 D | "C" (E G) E | "G" D2 G |
w: 1.~I wish to the Lord I'd nev-er been born, or
B2 A | (G A) B | "D" A3-| A2 G |
w: died when I - was young. - I'd
"G" B>B A | G2 D | "C" (EG) E | "G" D2 G |
w: nev-er have seen your spark-ling blue eyes, or
B2 G | "D" AB A | "G" G3-|G2 :|
w: heard your ly - ing tongue. -
`;

describe('generateHarmonyPart — All the Good Times (hand-checked golden)', () => {
  it('tenor: nearest chord tone above; diatonic thirds on passing tones', () => {
    const r = generateHarmonyPart(ALL_THE_GOOD_TIMES, { part: 'tenor' });
    expect(r.partLines).toEqual([
      '|:B | d2 d/c/ | B2 G | (G c) G | G2 B |',
      'd2 c | (B c) d | d3-| d2 B |',
      'd>d c | B2 G | (Gc) G | G2 B |',
      // bar 14: voice leading — the repeated d becomes the passing tone c
      // into the B cadence (D D C → B). Bars 4/12 (G G2 → B) do NOT fire:
      // the G2 is longer than its predecessor, and a passing tone may not
      // outlast the note it steps from.
      'd2 B | dd c | B3-|B2 :|',
    ]);
    // the pickup G is harmonized against the coming G chord (G→B, not a third)
    expect(r.warnings).toEqual([
      '1 pickup note(s) before the first chord symbol were harmonized ' +
        'against that first chord',
    ]);
  });

  it('voice leading is the ONLY deviation from the plain mapping', () => {
    // Guard against the pass getting adventurous: across the whole song
    // exactly one note may differ from the naive nearest-tone output
    // (bar 14: d→c passing into B).
    const r = generateHarmonyPart(ALL_THE_GOOD_TIMES, { part: 'tenor' });
    const joined = r.partLines.join(' ');
    // six c's from the plain mapping + exactly ONE added by voice leading
    expect(joined.match(/c/g)!.length).toBe(7);
    // and no A's anywhere — the bars-4/12 half-note fire is duration-blocked
    expect(joined.match(/A/g)).toBeNull();
  });

  it('baritone: nearest chord tone below, with octave-mark spelling', () => {
    const r = generateHarmonyPart(ALL_THE_GOOD_TIMES, { part: 'baritone' });
    // bar 2: melody G2 D over G — D4's nearest chord tone below is B3 ("B,")
    // bar-1 passing A over G takes the diatonic third below: F# ("F", key sig)
    expect(r.partLines[0]).toBe('|:D | G2 G/F/ | D2 B, | (C E) C | B,2 D |');
  });

  it('combined ABC interleaves voices with lyrics on the melody voice', () => {
    const r = generateHarmonyPart(ALL_THE_GOOD_TIMES, { part: 'tenor' });
    const lines = r.combinedAbc.split('\n');
    expect(lines).toContain('V: Melody');
    expect(lines).toContain('V: Tenor');
    // one SHARED staff, higher voice (tenor) first for stems-up
    expect(lines).toContain('%%staves (Tenor Melody)');
    const mel1 = lines.indexOf('[V: Melody] |:G | "G" B2 B/A/ | G2 D | "C" (E G) E | "G" D2 G |');
    expect(mel1).toBeGreaterThan(-1);
    // w: directly after its melody line; harmony line after the lyrics
    expect(lines[mel1 + 1]).toMatch(/^w: 1\.~I wish/);
    expect(lines[mel1 + 2]).toBe('[V: Tenor] |:B | d2 d/c/ | B2 G | (G c) G | G2 B |');
    // V: declarations precede K:
    expect(lines.indexOf('V: Melody')).toBeLessThan(lines.indexOf('K: G'));
  });

  it('baritone combined ABC lists the melody first on the shared staff', () => {
    const r = generateHarmonyPart(ALL_THE_GOOD_TIMES, { part: 'baritone' });
    expect(r.combinedAbc.split('\n')).toContain('%%staves (Melody Baritone)');
  });

  it('partAbc is a complete single-voice tune with the lyrics attached', () => {
    const r = generateHarmonyPart(ALL_THE_GOOD_TIMES, { part: 'tenor' });
    const lines = r.partAbc.split('\n');
    expect(lines[0]).toBe('X: 1');
    expect(lines).toContain('K: G');
    const h1 = lines.indexOf('|:B | d2 d/c/ | B2 G | (G c) G | G2 B |');
    expect(h1).toBeGreaterThan(-1);
    // the melody's w: lines follow each harmony line — the part is singable
    expect(lines[h1 + 1]).toMatch(/^w: 1\.~I wish/);
    // no voice headers and no chord symbols in the part-only view
    expect(r.partAbc).not.toContain('V:');
    expect(r.partAbc).not.toContain('"G"');
  });
});

describe('generateHarmonyPart — hard cases', () => {
  it('mid-measure chord change harmonizes each region against its chord', () => {
    const abc = 'X:1\nT:t\nM:4/4\nL:1/4\nK:G\n"G" B2 "D" A2 |\n';
    const r = generateHarmonyPart(abc, { part: 'tenor' });
    // B over G → d; A over D is now a chord tone (5th) → d
    expect(r.partLines).toEqual(['d2 d2 |']);
  });

  it('a tie continuation holds the harmony pitch across a chord change', () => {
    const abc = 'X:1\nT:t\nM:4/4\nL:1/4\nK:G\n"G" d3- | "C" d2 e2 |\n';
    const r = generateHarmonyPart(abc, { part: 'tenor' });
    // d5 over G → g5; the tied d keeps g even though the chord is now C;
    // e5 over C → g5 (nearest chord tone above)
    expect(r.partLines).toEqual(['g3- | g2 g2 |']);
  });

  it('repeats and voltas pass through verbatim', () => {
    const abc = 'X:1\nT:t\nM:4/4\nL:1/4\nK:C\n|: "C" C4 |1 "G" D4 :|2 "C" E4 |]\n';
    const r = generateHarmonyPart(abc, { part: 'tenor' });
    // C→E (chord tone above); D over G is a 5th → G above; E over C → G
    expect(r.partLines).toEqual(['|: E4 |1 G4 :|2 G4 |]']);
  });

  it('per-voice accidental state: melody naturals do not leak into the part', () => {
    // K:D — melody =c (natural) is measure-scoped in the MELODY voice; the
    // tenor above it is C#5, written plain "c" (key signature supplies #).
    const abc = 'X:1\nT:t\nM:4/4\nL:1/4\nK:D\n"A" =c2 c2 |\n';
    const r = generateHarmonyPart(abc, { part: 'tenor' });
    // =c → C5 natural — NOT a chord tone of A {A,C#,E} → diatonic third
    // above in D major = E5. The second (plain) c INHERITS the natural from
    // the melody's measure state → same non-chord tone, same third.
    expect(r.partLines).toEqual(['e2 e2 |']);
  });

  it('emits an explicit accidental when the harmony pitch needs one', () => {
    // K:C, A7 chord: melody A4 (root) → tenor = C#5, which needs "^c".
    const abc = 'X:1\nT:t\nM:4/4\nL:1/4\nK:C\n"A7" A2 A2 |\n';
    const r = generateHarmonyPart(abc, { part: 'tenor' });
    // second A repeats: ^c already in force for that measure → plain c
    expect(r.partLines).toEqual(['^c2 c2 |']);
  });

  it('rests and no-chord regions pass through / fall back to thirds', () => {
    const abc = 'X:1\nT:t\nM:4/4\nL:1/4\nK:C\n"C" C2 z2 | "N.C." D4 |\n';
    const r = generateHarmonyPart(abc, { part: 'tenor' });
    // D under N.C. → diatonic third above = F
    expect(r.partLines).toEqual(['E2 z2 | F4 |']);
  });

  it('no chords at all → whole part is diatonic thirds, with a warning', () => {
    const abc = 'X:1\nT:t\nM:4/4\nL:1/4\nK:C\nC D E F |\n';
    const r = generateHarmonyPart(abc, { part: 'tenor' });
    expect(r.partLines).toEqual(['E F G A |']);
    expect(r.warnings[0]).toMatch(/no chord symbols/);
  });

  it('rejects multi-voice ABC', () => {
    const abc = 'X:1\nT:t\nM:4/4\nL:1/4\nV: A\nK:C\n[V: A] C4 |\n';
    expect(() => generateHarmonyPart(abc, { part: 'tenor' })).toThrow(HarmonizeError);
  });

  it('text annotations and decorations are not chords and pass through', () => {
    const abc = 'X:1\nT:t\nM:4/4\nL:1/4\nK:C\n"C" C2 "^slow" !fermata!G2 |\n';
    const r = generateHarmonyPart(abc, { part: 'tenor' });
    // G over C is a chord tone → c above; the annotation/decoration survive
    expect(r.partLines).toEqual(['E2 !fermata!c2 |']);
  });
});

describe('closeHarmonyScore — arbitrary voice combinations', () => {
  it('all three voices, shared staff, top-down register order', () => {
    const r = closeHarmonyScore(ALL_THE_GOOD_TIMES, {
      parts: ['tenor', 'baritone'],
    });
    const lines = r.abc.split('\n');
    expect(lines).toContain('%%staves (Tenor Melody Baritone)');
    const vIdx = ['V: Tenor', 'V: Melody', 'V: Baritone'].map((v) => lines.indexOf(v));
    expect(vIdx.every((i) => i > -1)).toBe(true);
    expect([...vIdx]).toEqual([...vIdx].sort((a, b) => a - b));
    const t1 = lines.indexOf('[V: Tenor] |:B | d2 d/c/ | B2 G | (G c) G | G2 B |');
    expect(t1).toBeGreaterThan(-1);
    // On a SHARED staff the lyrics ride the first-written voice, not the
    // melody — abcjs offsets a lyric row by its voice's index on the stave, so
    // hanging them on the melody (voice 1) would detach them from the system.
    // The syllables align either way: every voice is generated note-for-note
    // from the melody.
    expect(lines[t1 + 1]).toMatch(/^w: 1\.~I wish/);
    expect(lines[t1 + 2]).toMatch(/^\[V: Melody\] /);
    expect(lines[t1 + 3]).toBe('[V: Baritone] |:D | G2 G/F/ | D2 B, | (C E) C | B,2 D |');
  });

  it('separate staves drop the parens in %%staves', () => {
    const r = closeHarmonyScore(ALL_THE_GOOD_TIMES, {
      parts: ['tenor'],
      sharedStaff: false,
    });
    expect(r.abc.split('\n')).toContain('%%staves Tenor Melody');
  });

  it('melody only reproduces a plain single-voice tune with lyrics', () => {
    const r = closeHarmonyScore(ALL_THE_GOOD_TIMES, { parts: [] });
    expect(r.abc).not.toContain('V:');
    expect(r.abc).toContain('|:G | "G" B2 B/A/');
    expect(r.abc).toContain('w: 1.~I wish');
  });

  it('a lone harmony part carries the lyrics itself (no melody)', () => {
    const r = closeHarmonyScore(ALL_THE_GOOD_TIMES, {
      parts: ['tenor'],
      includeMelody: false,
    });
    const lines = r.abc.split('\n');
    expect(r.abc).not.toContain('V:');
    const h1 = lines.indexOf('|:B | d2 d/c/ | B2 G | (G c) G | G2 B |');
    expect(h1).toBeGreaterThan(-1);
    expect(lines[h1 + 1]).toMatch(/^w: 1\.~I wish/);
  });

  it('tenor + baritone without melody: lyrics ride the top part', () => {
    const r = closeHarmonyScore(ALL_THE_GOOD_TIMES, {
      parts: ['tenor', 'baritone'],
      includeMelody: false,
    });
    const lines = r.abc.split('\n');
    expect(lines).toContain('%%staves (Tenor Baritone)');
    const t1 = lines.findIndex((l) => l.startsWith('[V: Tenor] |:B'));
    expect(lines[t1 + 1]).toMatch(/^w: 1\.~I wish/);
    expect(lines[t1 + 5]).toMatch(/^\[V: Baritone\] /);
  });

  it('no voices at all throws', () => {
    expect(() =>
      closeHarmonyScore(ALL_THE_GOOD_TIMES, { parts: [], includeMelody: false }),
    ).toThrow(HarmonizeError);
  });

  it('split layout still hangs the lyrics on the melody', () => {
    // The offset only applies to voices sharing a stave. With one stave per
    // voice each is voice 0, so the carrier attachment is what puts the words
    // under the melody's own staff — this branch must not change.
    const r = closeHarmonyScore(ALL_THE_GOOD_TIMES, {
      parts: ['tenor'],
      sharedStaff: false,
    });
    const lines = r.abc.split('\n');
    const m1 = lines.findIndex((l) => l.startsWith('[V: Melody] |:G'));
    expect(m1).toBeGreaterThan(-1);
    expect(lines[m1 + 1]).toMatch(/^w: 1\.~I wish/);
  });
});

/**
 * On a merged staff, lyrics hung on a voice other than the first are drawn
 * detached from the system, overprinting the next system's chord symbols and
 * the S:/N: credit lines. The cause is in abcjs, not in the lyric data:
 * write/layout/set-upper-and-lower-elements.js does
 * `child.pitch -= child.voiceNumber * child.lyricHeightBelow` for lyrics, so a
 * lyric row on voice N of a stave is pushed down N rows to leave room for the
 * lyrics of the voices above it — rows that do not exist here. Its own TODO
 * says as much. These tests render the real abcjs and measure, because the
 * emission is only correct in terms of what it makes abcjs draw.
 */
describe('merged-staff lyrics sit under their own system', () => {
  function render(abc: string): { lyricYs: number[]; height: number } {
    const div = document.createElement('div');
    document.body.appendChild(div);
    abcjs.renderAbc(div, abc, {});
    const svg = div.querySelector('svg')!;
    const lyricYs = Array.from(div.querySelectorAll('text'))
      .filter((t) => /I|wish/.test(t.textContent ?? ''))
      .map((t) => parseFloat(t.getAttribute('y') ?? '0'));
    const height = parseFloat(svg.getAttribute('height') ?? '0');
    div.remove();
    return { lyricYs, height };
  }

  it('does not reserve an empty lyric row above the words', () => {
    const shared = closeHarmonyScore(ALL_THE_GOOD_TIMES, { parts: ['tenor'] });

    // The same score with the lyrics hung on the melody (the second voice)
    // instead. Rendering both is what shows the difference is real: the ABC
    // differs only in which voice the w: lines follow.
    const lyricsOnSecondVoiceAbc = shared.abc
      .split('\n')
      .flatMap((l) => (l.startsWith('w:') ? [] : [l]))
      .flatMap((l) =>
        l.startsWith('[V: Melody]')
          ? [l, ...ALL_THE_GOOD_TIMES.split('\n').filter((x) => x.startsWith('w:')).slice(0, 1)]
          : [l],
      )
      .join('\n');

    const asGenerated = render(shared.abc);
    const lyricsOnSecondVoice = render(lyricsOnSecondVoiceAbc);

    expect(asGenerated.lyricYs.length).toBeGreaterThan(0);
    expect(lyricsOnSecondVoice.lyricYs.length).toBeGreaterThan(0);
    // Every lyric sits higher (closer to its staff) than when it rides the
    // second voice, and the score is correspondingly shorter — the missing
    // gap is the empty row abcjs reserves for a second-voice lyric.
    expect(Math.min(...asGenerated.lyricYs)).toBeLessThan(Math.min(...lyricsOnSecondVoice.lyricYs));
    expect(asGenerated.height).toBeLessThan(lyricsOnSecondVoice.height);
  });

  it('keeps the melody as the lyric carrier when it is written first', () => {
    // Melody + baritone: the melody already leads, so nothing moves.
    const r = closeHarmonyScore(ALL_THE_GOOD_TIMES, { parts: ['baritone'] });
    const lines = r.abc.split('\n');
    expect(lines).toContain('%%staves (Melody Baritone)');
    const m1 = lines.findIndex((l) => l.startsWith('[V: Melody] |:G'));
    expect(lines[m1 + 1]).toMatch(/^w: 1\.~I wish/);
  });
});

describe('refineVoiceLeading — conservative guards', () => {
  it('fires on runs of two or more repeated notes', () => {
    const three = 'X:1\nT:t\nM:4/4\nL:1/4\nK:G\n"D" A A A "G" G4 |\n';
    const r3 = generateHarmonyPart(three, { part: 'tenor' });
    // A(5th of D) → d, three times; G(root of G) → B: d d c B
    expect(r3.partLines).toEqual(['d d c B4 |']);
    const two = 'X:1\nT:t\nM:4/4\nL:1/4\nK:G\n"D" A A "G" G2 |\n';
    const r2 = generateHarmonyPart(two, { part: 'tenor' });
    expect(r2.partLines).toEqual(['d c B2 |']);
    // a single note before the third never fires — no run at all
    // (G→B over G, A→d over D, G→B: the d moves a third to B but its
    // predecessor differs, so it stays put)
    const one = 'X:1\nT:t\nM:4/4\nL:1/4\nK:G\n"G" G "D" A "G" G2 |\n';
    const r1 = generateHarmonyPart(one, { part: 'tenor' });
    expect(r1.partLines).toEqual(['B d B2 |']);
  });

  it('never lengthens: a repeat LONGER than its predecessor stays put', () => {
    // d d2 → B: the d2 half note outlasts the quarter it repeats — a
    // passing tone there would sustain a non-chord tone longer than the
    // chord tone it left. Equal or shorter still fires (the `two` case
    // above; d/ after d fires too).
    const longer = 'X:1\nT:t\nM:4/4\nL:1/4\nK:G\n"D" A A2 "G" G |\n';
    const rL = generateHarmonyPart(longer, { part: 'tenor' });
    expect(rL.partLines).toEqual(['d d2 B |']);
    const shorter = 'X:1\nT:t\nM:4/4\nL:1/4\nK:G\n"D" A2 A/ A/ "G" G |\n';
    const rS = generateHarmonyPart(shorter, { part: 'tenor' });
    expect(rS.partLines).toEqual(['d2 d/ c/ B |']);
  });

  it('never breaks a tie', () => {
    const abc = 'X:1\nT:t\nM:4/4\nL:1/4\nK:G\n"D" A A A- | A "G" G3 |\n';
    const r = generateHarmonyPart(abc, { part: 'tenor' });
    // the 3rd d is tied into bar 2 — untouchable
    expect(r.partLines).toEqual(['d d d- | d B3 |']);
  });

  it('skips when the passing tone would sit on/too close to the melody', () => {
    // Tenor over melody B B B → G in K:C. A passing c here would sit one
    // semitone above the melody's B (72 vs 71), too close to be allowed, so
    // the plain mapping must come through unchanged.
    const abc = 'X:1\nT:t\nM:4/4\nL:1/4\nK:C\n"G" B B B "C" G4 |\n';
    const r = generateHarmonyPart(abc, { part: 'tenor' });
    // B over G → d (3rd→5th); G over C → c. The step d(74)→c(72) is a 2nd,
    // not a third, so the pass has nothing to fill: output is unchanged.
    expect(r.partLines).toEqual(['d d d c4 |']);
  });
});

describe('generateHarmonyPart — chordTone mode', () => {
  const SIMPLE = `X:1
M:4/4
L:1/4
K:C
"C" C E G E | "G" D G B G | "C" E2 C2 |
`;

  it('root: one held root per chord region, repeats tied', () => {
    const r = generateHarmonyPart(SIMPLE, { mode: 'chordTone', tone: 'root', part: 'baritone' });
    expect(r.partLines).toEqual(['C,- C,- C,- C, | G,- G,- G,- G, | C2- C2 |']);
  });

  it('third: holds the chord third below the melody', () => {
    const r = generateHarmonyPart(SIMPLE, { mode: 'chordTone', tone: 'third', part: 'baritone' });
    expect(r.partLines).toEqual(['E,- E,- E,- E, | B,- B,- B,- B, | E,2- E,2 |']);
  });

  it('fifth: holds the chord fifth below the melody', () => {
    const r = generateHarmonyPart(SIMPLE, { mode: 'chordTone', tone: 'fifth', part: 'baritone' });
    expect(r.partLines).toEqual(['G,- G,- G,- G, | D,- D,- D,- D, | G,2- G,2 |']);
  });

  it('closeHarmonyScore includes the ChordTone voice below the melody', () => {
    const r = closeHarmonyScore(SIMPLE, { parts: [], chordTone: 'root' });
    expect(r.abc).toContain('%%staves (Melody ChordTone)');
    expect(r.abc).toContain('[V: ChordTone] C,- C,- C,- C, | G,- G,- G,- G, | C2- C2 |');
  });
});

// ---------------------------------------------------------------------------
// ABC inline `%` comments on header fields (K:, M:, L:)
// ---------------------------------------------------------------------------

/**
 * A real hymn melody, verbatim: *Savior of the Nations Come* from the Open
 * Hymnal. Every Open Hymnal file writes its structural headers with an inline
 * comment. abcjs strips such comments per the ABC spec when rendering, so the
 * harmonizer must strip them too, or a tune that renders fine cannot be
 * harmonized.
 */
const SAVIOR_OF_THE_NATIONS_COME = `X: 43
T: Savior Of The Nations Come
C: Traditional
M: 4/4 % time signature
L: 1/4 % default length
O:German
Q:1/4=100
R:hymn
K: Gm % key signature
"Gm" G G "Dm"F B |"Adim" A/G/ A "Gm" G2 |"Gm" G B "Cm"c3/2 B/ |"F" c d "Bb"B2 |
w: 1.~Sa- vior of the na- * tions, come; Vir- gin's Son, here make Thy home!
"Bb"  B c d B |"Cm" c B/A/ "Gm" G2 |"Eb" G G "Dm"F B |"D" A/G/ A "Gm" G2 |]
w: Mar- vel now, O heav'n and * earth, That the Lord chose such * a birth.
`;

describe('stripAbcComment', () => {
  it('drops an inline comment and re-trims', () => {
    expect(stripAbcComment('Gm % key signature')).toBe('Gm');
    expect(stripAbcComment('Gm%x')).toBe('Gm');
    expect(stripAbcComment('  Gm   %  anything  ')).toBe('Gm');
  });

  it('leaves a clean value byte-identical', () => {
    expect(stripAbcComment('Bb')).toBe('Bb');
    expect(stripAbcComment('G mixolydian')).toBe('G mixolydian');
  });

  it('honours the ABC escape `\\%`', () => {
    expect(stripAbcComment('G \\% not a comment')).toBe('G % not a comment');
  });
});

describe('generateHarmonyPart tolerates commented headers', () => {
  it('computes a TENOR part for the Open Hymnal melody', () => {
    const r = generateHarmonyPart(SAVIOR_OF_THE_NATIONS_COME, { part: 'tenor' });
    expect(r.partLines.length).toBeGreaterThan(0);
    expect(r.partLines.join(' ').trim()).not.toBe('');
  });

  it('computes a BARITONE part for it too', () => {
    const r = generateHarmonyPart(SAVIOR_OF_THE_NATIONS_COME, { part: 'baritone' });
    expect(r.partLines.length).toBeGreaterThan(0);
  });

  it('reads the key through the comment (G minor, not a KeyParseError)', () => {
    const clean = SAVIOR_OF_THE_NATIONS_COME.replace('K: Gm % key signature', 'K: Gm');
    expect(generateHarmonyPart(SAVIOR_OF_THE_NATIONS_COME, { part: 'tenor' }).partLines)
      .toEqual(generateHarmonyPart(clean, { part: 'tenor' }).partLines);
  });

  it('closeHarmonyScore works on it for both parts at once', () => {
    const r = closeHarmonyScore(SAVIOR_OF_THE_NATIONS_COME, { parts: ['tenor', 'baritone'] });
    expect(r.abc).toContain('%%staves');
  });
});
