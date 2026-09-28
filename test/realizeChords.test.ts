import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { realizeChords, RealizeError } from '../src/realize.js';

/**
 * Golden test for the faithful translator: realizeChords(text) must reproduce —
 * byte for byte — the reference `.abc` stored next to each `.chords` fixture.
 * Unlike the per-bar form golden, this pins the FULL document: header
 * pass-through (O:/R:/S:), the author's line breaks, and P: part markers
 * (autumn_leaves, bye_bye_blackbird).
 */

const corpus = resolve(process.cwd(), 'test/fixtures/chords_corpus');
const names = readdirSync(corpus)
  .filter((f) => f.endsWith('.chords'))
  .map((f) => f.slice(0, -'.chords'.length))
  .sort();

describe('realizeChords — byte-identical to the reference ABC', () => {
  it('has a non-empty fixture set', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    it(`realizes ${name}.chords to match ${name}.abc`, () => {
      const text = readFileSync(resolve(corpus, `${name}.chords`), 'utf8');
      const want = readFileSync(resolve(corpus, `${name}.abc`), 'utf8');
      expect(realizeChords(text)).toBe(want);
    });
  }
});

describe('realizeChords — errors', () => {
  it('throws on an invalid .chords source', () => {
    expect(() => realizeChords('not a chords file')).toThrow(RealizeError);
  });

  it('throws when a required header is missing', () => {
    // Valid structure + version, but no M:/L:/K:.
    const text = ['%chords-1.0', 'T: X', 'C7 |]'].join('\n');
    expect(() => realizeChords(text)).toThrow(RealizeError);
  });
});
