/**
 * The canonical chord-quality vocabulary, loaded from the vendored
 * `chord_types.json` data file (a language-neutral definition that other
 * `.chords` implementations can share). A `.chords` quality alias
 * (e.g. `m7`) maps to a canonical type (`min7`) with a known interval pattern
 * and a scorable decomposition (quality / seventh / extensions).
 */

import rawData from './chord_types.json';

/** A chord-quality definition from the vocabulary. */
export interface ChordType {
  /** Canonical name, e.g. `min7`. */
  canonical: string;
  /** As-written aliases (including `''` for a bare major triad). */
  aliases: string[];
  /** Interval pattern, e.g. `['1','b3','5','b7']`. */
  intervalPattern: string[];
  /** Triad quality: major / minor / diminished / augmented / suspended. */
  quality: string;
  hasSeventh: boolean;
  /** dominant / major / minor / diminished, or null. */
  seventhType: string | null;
  /** Extension tokens, e.g. `['9','11']`. */
  extensions: string[];
  isSuspended: boolean;
  description?: string;
}

/** The chord vocabulary, indexed for parsing (see {@link loadVocabulary}). */
export interface ChordVocabulary {
  /** Canonical type → its full definition. */
  entryByCanonical: Map<string, ChordType>;
  /** As-written alias (including `''`) → canonical type. */
  aliasToCanonical: Map<string, string>;
  /** All aliases sorted longest-first (so `maj7` beats `m`, `6/9` beats `6`). */
  aliasesLongestFirst: string[];
}

interface RawEntry {
  canonical: string;
  aliases: string[];
  interval_pattern: string[];
  quality?: string;
  has_seventh?: boolean;
  seventh_type?: string | null;
  extensions?: string[];
  is_suspended?: boolean;
  description?: string;
}

let _cached: ChordVocabulary | null = null;

/** Build (and memoize) the vocabulary from the bundled `chord_types.json`. */
export function loadVocabulary(): ChordVocabulary {
  if (_cached) return _cached;

  const entries = (rawData as { chord_types: RawEntry[] }).chord_types;
  const entryByCanonical = new Map<string, ChordType>();
  const aliasToCanonical = new Map<string, string>();

  for (const e of entries) {
    entryByCanonical.set(e.canonical, {
      canonical: e.canonical,
      aliases: e.aliases,
      intervalPattern: e.interval_pattern,
      quality: e.quality ?? 'major',
      hasSeventh: e.has_seventh ?? false,
      seventhType: e.seventh_type ?? null,
      extensions: e.extensions ?? [],
      isSuspended: e.is_suspended ?? false,
      description: e.description,
    });
    for (const alias of e.aliases) {
      if (!aliasToCanonical.has(alias)) aliasToCanonical.set(alias, e.canonical);
    }
    if (!aliasToCanonical.has(e.canonical)) {
      aliasToCanonical.set(e.canonical, e.canonical);
    }
  }

  const aliasesLongestFirst = [...aliasToCanonical.keys()].sort(
    (a, b) => b.length - a.length,
  );

  _cached = { entryByCanonical, aliasToCanonical, aliasesLongestFirst };
  return _cached;
}
