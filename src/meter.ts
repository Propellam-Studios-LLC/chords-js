/**
 * Meter (`M:`) and unit-length (`L:`) helpers. Each throws {@link MeterError}
 * on a malformed value.
 *
 * `.chords` durations are **measure-relative**: a bare chord lasts one `L:`
 * unit, and a bar's chords sum to one measure regardless of the meter.
 */

const FRACTION_RE = /^(\d+)\/(\d+)$/;

export class MeterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeterError';
  }
}

/**
 * Parse an `M:` value into `[numerator, denominator]`. `C` is 4/4, `C|` is 2/2,
 * and `none` (free meter) gives `[null, null]`. Throws {@link MeterError} for
 * anything else that is not a positive `n/d` fraction.
 *
 * @example meterNumDen('6/8') // → [6, 8]
 */
export function meterNumDen(m: string): [number | null, number | null] {
  const v = m.trim();
  if (v.toLowerCase() === 'none') return [null, null];
  if (v === 'C') return [4, 4];
  if (v === 'C|' || v === 'C |') return [2, 2];
  const fm = FRACTION_RE.exec(v);
  if (!fm) throw new MeterError(`M: '${m}' is not a valid meter (e.g. 4/4, 6/8, C).`);
  const num = parseInt(fm[1], 10);
  const den = parseInt(fm[2], 10);
  if (!(num > 0) || !(den > 0)) {
    throw new MeterError(`M: '${m}' needs a positive numerator and denominator (e.g. 4/4).`);
  }
  return [num, den];
}

/**
 * Whether [m] is a COMPOUND meter — one whose felt beat is a dotted note (6/8,
 * 9/8, 12/8 and their /16 cousins), so the comping pulse steps by a dotted
 * quarter rather than a quarter.
 *
 * 3/8 is deliberately simple: it is conventionally counted in three eighths
 * rather than as one dotted beat.
 *
 * The single owner of this rule — the realizer's beat grid and the validator's
 * duration check must agree about where a bar's slots are, or a chart validates
 * and then comps off the beat.
 */
export function isCompoundMeter(m: string): boolean {
  const [num, den] = meterNumDen(m);
  if (num === null) return false;
  return (den === 8 || den === 16) && num % 3 === 0 && num > 3;
}

/**
 * The `L:` unit as a fraction of a MEASURE (e.g. `1/2` → 0.5). Throws
 * {@link MeterError} unless the value is a positive `n/d` fraction.
 */
export function lengthToFraction(l: string): number {
  const fm = FRACTION_RE.exec(l.trim());
  if (!fm) {
    throw new MeterError(`L: '${l}' is not a valid unit length (e.g. 1/1, 1/2).`);
  }
  const num = parseInt(fm[1], 10);
  const den = parseInt(fm[2], 10);
  if (!(num > 0) || !(den > 0)) {
    throw new MeterError(`L: '${l}' needs a positive numerator and denominator (e.g. 1/1).`);
  }
  return num / den;
}
