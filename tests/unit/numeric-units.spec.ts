import {
  asPercent,
  asProbability,
  isPercent,
  isProbability,
  percentToProbability,
  probabilityToPercent,
} from '@domain/types';

describe('Probability (0..1 extraction confidence, SRS B.1/B.2)', () => {
  it('accepts inclusive boundary values', () => {
    expect(asProbability(0)).toBe(0);
    expect(asProbability(1)).toBe(1);
    expect(asProbability(0.94)).toBe(0.94);
  });

  it('rejects values outside [0, 1]', () => {
    expect(() => asProbability(-0.01)).toThrow(RangeError);
    expect(() => asProbability(1.01)).toThrow(RangeError);
    expect(() => asProbability(100)).toThrow(RangeError);
  });

  it('rejects non-finite and non-numeric values', () => {
    expect(() => asProbability(Number.NaN)).toThrow(RangeError);
    expect(() => asProbability(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => asProbability(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });

  it('guards with isProbability without throwing', () => {
    expect(isProbability(0.5)).toBe(true);
    expect(isProbability(0)).toBe(true);
    expect(isProbability(1)).toBe(true);
    expect(isProbability(1.5)).toBe(false);
    expect(isProbability(-1)).toBe(false);
    expect(isProbability(Number.NaN)).toBe(false);
    expect(isProbability('0.5')).toBe(false);
    expect(isProbability(null)).toBe(false);
    expect(isProbability(undefined)).toBe(false);
  });
});

describe('Percent (0..100 match score/confidence, SRS B.3)', () => {
  it('accepts inclusive boundary values', () => {
    expect(asPercent(0)).toBe(0);
    expect(asPercent(100)).toBe(100);
    expect(asPercent(84)).toBe(84);
  });

  it('rejects values outside [0, 100]', () => {
    expect(() => asPercent(-1)).toThrow(RangeError);
    expect(() => asPercent(101)).toThrow(RangeError);
  });

  it('rejects non-finite and non-numeric values', () => {
    expect(() => asPercent(Number.NaN)).toThrow(RangeError);
    expect(() => asPercent(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('guards with isPercent without throwing', () => {
    expect(isPercent(50)).toBe(true);
    expect(isPercent(0)).toBe(true);
    expect(isPercent(100)).toBe(true);
    expect(isPercent(100.01)).toBe(false);
    expect(isPercent(-0.01)).toBe(false);
    expect(isPercent(Number.NaN)).toBe(false);
    expect(isPercent('50')).toBe(false);
    expect(isPercent(null)).toBe(false);
  });
});

describe('explicit unit conversion', () => {
  it('converts probability to percent', () => {
    expect(probabilityToPercent(asProbability(0))).toBe(0);
    expect(probabilityToPercent(asProbability(0.84))).toBe(84);
    expect(probabilityToPercent(asProbability(1))).toBe(100);
  });

  it('converts percent to probability', () => {
    expect(percentToProbability(asPercent(0))).toBe(0);
    expect(percentToProbability(asPercent(91))).toBe(0.91);
    expect(percentToProbability(asPercent(100))).toBe(1);
  });

  it('round trips without meaningful drift for representative SRS values', () => {
    for (const value of [0, 0.6, 0.84, 0.91, 0.94, 0.99, 1]) {
      const roundTripped = percentToProbability(probabilityToPercent(asProbability(value)));
      expect(roundTripped).toBeCloseTo(value, 10);
    }
  });
});
