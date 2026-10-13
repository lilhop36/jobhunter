/**
 * Validated numeric units.
 *
 * JobHunter deliberately keeps two distinct confidence/score scales and never
 * mixes them:
 *
 *   - Probability: [0, 1]  — per-field extraction confidence (SRS B.1, B.2)
 *   - Percent:     [0, 100] — match score and confidence (SRS B.3)
 *
 * Constructors validate at runtime so an out-of-range value fails loudly at
 * the boundary instead of silently propagating. Conversions are explicit.
 */

export type Probability = number & { readonly __unit: 'Probability' };

export type Percent = number & { readonly __unit: 'Percent' };

export function isProbability(value: unknown): value is Probability {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isPercent(value: unknown): value is Percent {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function asProbability(value: number): Probability {
  if (!isProbability(value)) {
    throw new RangeError(`Probability must be a finite number in [0, 1]; received ${String(value)}`);
  }
  return value;
}

export function asPercent(value: number): Percent {
  if (!isPercent(value)) {
    throw new RangeError(`Percent must be a finite number in [0, 100]; received ${String(value)}`);
  }
  return value;
}

export function probabilityToPercent(value: Probability): Percent {
  return asPercent(value * 100);
}

export function percentToProbability(value: Percent): Probability {
  return asProbability(value / 100);
}
