/**
 * Formats a chord's canonical type + root into a readable chord symbol.
 *
 * Single-sourced so the realizer (lead-sheet annotations) and any chart/label
 * consumer render symbols identically. The stored `form` keeps a chord's
 * canonical type (not the author's written alias), so we reconstruct a
 * conventional suffix from the canonical name.
 */

/** Display suffix for a canonical chord type, e.g. `min7` → `m7`, `maj` → ``. */
export function displaySuffixFor(canonical: string): string {
  const map: Record<string, string> = {
    maj: '',
    min: 'm',
    dom7: '7',
    maj7: 'maj7',
    min7: 'm7',
    m7b5: 'm7b5',
    dim: 'dim',
    dim7: 'dim7',
    aug: 'aug',
    min6: 'm6',
    minb6: 'm(b6)',
    '6': '6',
    minmaj7: 'm(maj7)',
    sus4: 'sus4',
    sus2: 'sus2',
  };
  const mapped = map[canonical];
  if (mapped !== undefined) return mapped;
  // Fallbacks for canonicals not in the map: dom* → strip 'dom' (dom9 → 9);
  // min* → 'm' + rest (min11 → m11); digit-led / maj* stay as written.
  if (canonical.startsWith('dom')) return canonical.slice(3);
  if (canonical.startsWith('min')) return `m${canonical.slice(3)}`;
  return canonical;
}

/**
 * A full chord symbol: root + type suffix + optional slash bass, e.g.
 * (`C`, `min7`, null) → `Cm7`; (`G`, `dom7`, `B`) → `G7/B`.
 */
export function chordSymbol(
  root: string,
  type: string,
  bass?: string | null,
): string {
  return `${root}${displaySuffixFor(type)}${bass ? `/${bass}` : ''}`;
}
