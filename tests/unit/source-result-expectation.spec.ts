import { describe, expect, it } from 'vitest';
import { SourceResultExpectation, isUnexpectedZeroResult } from '@domain/types';

/**
 * The zero-result policy (ADR-0001 section 4, AC-018).
 *
 * An empty run is only *unexpected* when an explicit source expectation says results were
 * expected. "We have no expectation recorded" is not evidence of breakage, so it must not
 * raise a health signal.
 */
describe('isUnexpectedZeroResult', () => {
  it('never flags a run that collected something', () => {
    for (const expectation of Object.values(SourceResultExpectation)) {
      expect(isUnexpectedZeroResult(1, expectation)).toBe(false);
      expect(isUnexpectedZeroResult(50, expectation)).toBe(false);
    }
  });

  it('flags an empty run when the source is expected to yield results', () => {
    expect(isUnexpectedZeroResult(0, SourceResultExpectation.RESULTS_EXPECTED)).toBe(true);
  });

  it('does not flag an empty run when no expectation is recorded', () => {
    expect(isUnexpectedZeroResult(0, SourceResultExpectation.UNKNOWN)).toBe(false);
  });

  it('does not flag an empty run when the source may legitimately be empty', () => {
    expect(isUnexpectedZeroResult(0, SourceResultExpectation.ZERO_EXPECTED)).toBe(false);
  });
});
