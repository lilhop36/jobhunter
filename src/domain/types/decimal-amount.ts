/**
 * Exact monetary amount (SRS ENG-006).
 *
 * Money is stored and passed around as an exact decimal string, never as a
 * binary floating point number. The canonical form is a non-negative decimal
 * with at most two fractional digits — the scale of the canonical
 * `DECIMAL(14,2)` storage. Arithmetic on amounts must go through decimal-aware
 * helpers (see `compareDecimalAmount`), not `Number`.
 *
 * The constructor validates at the boundary so an out-of-scale or malformed
 * value fails loudly instead of silently rounding.
 */
export type DecimalAmount = string & { readonly __unit: 'DecimalAmount' };

const DECIMAL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

export function isDecimalAmount(value: unknown): value is DecimalAmount {
  return typeof value === 'string' && DECIMAL_AMOUNT.test(value);
}

export function asDecimalAmount(value: string): DecimalAmount {
  if (!isDecimalAmount(value)) {
    throw new RangeError(
      'Not an exact monetary amount (expected a non-negative decimal with at most 2 fractional digits, no separators or exponent): ' +
        JSON.stringify(value),
    );
  }
  return value;
}

/**
 * Compares two amounts numerically. Returns -1, 0 or 1. Both inputs must be
 * canonical `DecimalAmount`s; integer parts have no leading zeros, so length
 * ordering is numeric ordering.
 */
export function compareDecimalAmount(a: DecimalAmount, b: DecimalAmount): number {
  const [aInt, aFrac = ''] = a.split('.');
  const [bInt, bFrac = ''] = b.split('.');
  if (aInt.length !== bInt.length) return aInt.length < bInt.length ? -1 : 1;
  if (aInt !== bInt) return aInt < bInt ? -1 : 1;
  const aScaled = (aFrac + '00').slice(0, 2);
  const bScaled = (bFrac + '00').slice(0, 2);
  if (aScaled === bScaled) return 0;
  return aScaled < bScaled ? -1 : 1;
}
