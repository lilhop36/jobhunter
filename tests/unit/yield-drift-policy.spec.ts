import {
  YIELD_BASELINE_MINIMUM_PARSED,
  YIELD_BASELINE_RUN_LIMIT,
  YIELD_COLLAPSE_RATIO,
  YIELD_DRIFT_POLICY_VERSION,
  classifyYieldDrift,
  noYieldDrift,
} from '@domain/health/source-yield-drift';

/**
 * Reduced-yield detection (SRS 7.8, FR-020).
 *
 * The property that matters: a source that still returns a page but extracts far less than it
 * used to must be distinguishable from a healthy one, and a source with no usable history
 * must not be judged at all. The SRS says "sharply reduced" without a number; these tests pin
 * the documented engineering thresholds so a change to them is a visible decision.
 */

function drift(current: { listed: number; parsed: number }, baseline: Array<{ listed: number; parsed: number }>) {
  return classifyYieldDrift({ current, baseline });
}

describe('classifyYieldDrift', () => {
  it('names its policy version and documents its thresholds', () => {
    expect(YIELD_DRIFT_POLICY_VERSION).toBe('FR-020_YIELD_DRIFT_V1');
    expect(YIELD_COLLAPSE_RATIO).toBe(0.5);
    expect(YIELD_BASELINE_MINIMUM_PARSED).toBe(5);
    expect(YIELD_BASELINE_RUN_LIMIT).toBe(3);
  });

  it('gives no verdict when the source has no clean history', () => {
    // A first run is not evidence of anything, and treating "no baseline" as "baseline zero"
    // would degrade every new source on its first collection.
    expect(drift({ listed: 3, parsed: 3 }, [])).toEqual(noYieldDrift());
  });

  it('warns on an 80% yield drop', () => {
    const verdict = drift({ listed: 10, parsed: 4 }, [{ listed: 20, parsed: 20 }]);
    expect(verdict.drifted).toBe(true);
    expect(verdict.baselineParsed).toBe(20);
    expect(verdict.reason).toContain('4 of 10');
    expect(verdict.reason).toContain('baseline of 20');
  });

  it('warns when a visit finds listings but extracts none', () => {
    // `isUnexpectedZeroResult` only fires when the listing itself is empty; a selector that
    // reads cards and parses nothing is this rule's case.
    expect(drift({ listed: 10, parsed: 0 }, [{ listed: 20, parsed: 20 }]).drifted).toBe(true);
  });

  it('does not warn at exactly half of the baseline, or above it', () => {
    expect(drift({ listed: 10, parsed: 10 }, [{ listed: 20, parsed: 20 }]).drifted).toBe(false);
    expect(drift({ listed: 12, parsed: 12 }, [{ listed: 20, parsed: 20 }]).drifted).toBe(false);
  });

  it('refuses to judge a baseline too small to separate drift from variance', () => {
    expect(drift({ listed: 0, parsed: 0 }, [{ listed: 4, parsed: 4 }])).toEqual(noYieldDrift());
  });

  it('takes the median of the recent runs, so one outlier does not set the norm', () => {
    // A backlog dump followed by two ordinary runs: 20, 20, 2 -> median 20.
    const verdict = drift(
      { listed: 8, parsed: 8 },
      [
        { listed: 20, parsed: 20 },
        { listed: 20, parsed: 20 },
        { listed: 2, parsed: 2 },
      ],
    );
    expect(verdict.drifted).toBe(true);
    expect(verdict.reason).toContain('median of 3 clean runs');
  });

  it('averages an even-sized baseline and names a single run in the singular', () => {
    const even = drift(
      { listed: 5, parsed: 5 },
      [
        { listed: 10, parsed: 10 },
        { listed: 11, parsed: 11 },
      ],
    );
    // median 10.5, threshold 5.25: 5 is below it
    expect(even.drifted).toBe(true);
    expect(even.baselineParsed).toBe(10.5);

    const single = drift({ listed: 1, parsed: 1 }, [{ listed: 18, parsed: 18 }]);
    expect(single.drifted).toBe(true);
    expect(single.reason).toContain('median of 1 clean run)');
  });
});
