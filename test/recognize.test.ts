import { describe, it, expect } from 'vitest';
import { recognizeChord } from '../src/recognize.js';
import { parseKey } from '../src/key.js';
import { chordTonePitchClasses } from '../src/realize.js';

const C = parseKey('C');

/** Pitch classes of a chord, via the forward direction (round-trip helper). */
function pcs(root: string, type: string): number[] {
  return [...chordTonePitchClasses(root, type)];
}

describe('recognizeChord', () => {
  it('round-trips a diatonic major triad in C', () => {
    const r = recognizeChord(pcs('C', 'maj'), C);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.root).toBe('C');
      expect(r.type).toBe('maj');
      expect(r.symbol).toBe('C');
    }
  });

  it('round-trips a minor seventh', () => {
    const r = recognizeChord(pcs('D', 'min7'), C);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.root).toBe('D');
      expect(r.type).toBe('min7');
    }
  });

  it('round-trips a dominant seventh on the V', () => {
    const r = recognizeChord(pcs('G', 'dom7'), C);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.root).toBe('G');
  });

  it('spells the root diatonically in the key (Bb major)', () => {
    const bb = parseKey('Bb');
    const r = recognizeChord(pcs('Eb', 'maj'), bb);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.root).toBe('Eb'); // not D#
  });

  it('names an inversion as a slash chord when asked', () => {
    // C major triad with E (pc 4) in the bass → C/E.
    const r = recognizeChord(pcs('C', 'maj'), C, {
      recognizeSlashChords: true,
      bassPc: 4,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.root).toBe('C');
      expect(r.bass).toBe('E');
      expect(r.symbol).toBe('C/E');
    }
  });

  it('omits the slash when the bass is the root', () => {
    const r = recognizeChord(pcs('C', 'maj'), C, {
      recognizeSlashChords: true,
      bassPc: 0,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bass).toBeNull();
  });

  it('reports a failure with the offending pitch classes for an unknown set', () => {
    // Two notes a semitone apart — not a recognized chord.
    const r = recognizeChord([0, 1], C);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.pitchClasses).toEqual([0, 1]);
      expect(r.reason).toContain('unrecognized');
    }
  });

  it('fails on an empty pitch set', () => {
    const r = recognizeChord([], C);
    expect(r.ok).toBe(false);
  });

  it('is voicing/octave-agnostic (duplicate + out-of-order pcs)', () => {
    const r = recognizeChord([7, 4, 0, 0, 12], C); // C E G with dupes/octave
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.root).toBe('C');
      expect(r.type).toBe('maj');
    }
  });
});
