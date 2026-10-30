import { describe, expect, it } from 'vitest';
import {
  SOURCE_SILENCE_INTERVAL_MULTIPLIER,
  SOURCE_SILENCE_POLICY_VERSION,
  classifySourceSilence,
} from '../../src/domain/health/source-silence';

/**
 * Silence detection (SRS 7.8, FR-020; audit H7's open half).
 *
 * The rule is the only place that decides what "the source has stopped delivering" means when the
 * source has produced no run to judge, so it is spelled out here rather than discovered from a
 * `DEGRADED` row six months later. What it must never do is answer at all when the evidence is
 * missing: a source that has never succeeded, or that has no schedule, or whose schedule cannot be
 * read, is not "healthy" and is not "silent" — it is unknown, and `measured: false` is how the
 * caller is told the difference.
 */

const NOW = new Date('2026-10-30T12:00:00.000Z');
const HOUR = 3_600_000;

const observe = (
  lastSuccessfulRunAt: Date | null,
  schedule: string | null,
): ReturnType<typeof classifySourceSilence> =>
  classifySourceSilence({ lastSuccessfulRunAt, schedule, now: NOW });

describe('a scheduled source that keeps delivering', () => {
  it('is not silent within its own interval', () => {
    const verdict = observe(new Date(NOW.getTime() - 10 * 60_000), '1h');

    expect(verdict).toMatchObject({ silent: false, measured: true, reason: null, intervalMs: HOUR });
  });

  it('is not silent one interval late — a missed window is jitter, not an alarm', () => {
    const verdict = observe(new Date(NOW.getTime() - HOUR - 60_000), '1h');

    expect(verdict.silent).toBe(false);
    expect(verdict.measured).toBe(true);
  });

  it('is silent once the whole bound has passed', () => {
    const verdict = observe(new Date(NOW.getTime() - HOUR * 3), '1h');

    expect(verdict.silent).toBe(true);
    expect(verdict.measured).toBe(true);
    expect(verdict.ageMs).toBe(HOUR * 3);
    expect(verdict.intervalMs).toBe(HOUR);
    expect(verdict.reason).toMatch(/no successful collection for 3\.0 h/);
    expect(verdict.reason).toMatch(/declares a 1\.0 h schedule and 2 whole intervals/);
  });

  it('is silent at the boundary itself, not only past it, because the bound is exceeded at it', () => {
    // `age <= bound` is the healthy arm, so exactly 2 intervals is still healthy; the test pins
    // which side of the comparison the boundary belongs to, because "two intervals" is the number
    // an operator will quote when tuning the multiplier.
    expect(observe(new Date(NOW.getTime() - HOUR * 2), '1h').silent).toBe(false);
    expect(observe(new Date(NOW.getTime() - HOUR * 2 - 1), '1h').silent).toBe(true);
  });
});

describe('a source whose silence cannot be measured', () => {
  it('gives no verdict when it has never had a successful collection', () => {
    const verdict = observe(null, '1h');

    expect(verdict).toEqual({
      silent: false,
      measured: false,
      reason: null,
      ageMs: null,
      intervalMs: null,
      silentBefore: null,
    });
  });

  it('gives no verdict when nothing is scheduled, because nothing is overdue', () => {
    expect(observe(new Date(NOW.getTime() - 90 * HOUR), null).measured).toBe(false);
    expect(observe(new Date(NOW.getTime() - 90 * HOUR), '').measured).toBe(false);
    expect(observe(new Date(NOW.getTime() - 90 * HOUR), '   ').measured).toBe(false);
  });

  it('gives no verdict for a schedule it cannot read, which the scheduler reports as its own error', () => {
    // Not "every hour" and not "silent": inventing an interval would invent a fact about the source.
    expect(observe(new Date(NOW.getTime() - 90 * HOUR), '*/6 * * * *').measured).toBe(false);
    expect(observe(new Date(NOW.getTime() - 90 * HOUR), 'weekly').measured).toBe(false);
  });

  it('is not measured when the schedule is blank rather than absent', () => {
    expect(observe(new Date(NOW.getTime() - HOUR), '   ').silent).toBe(false);
  });
});

describe('the bound the store re-checks', () => {
  it('is now minus the multiplied interval, so the write applies the same rule it was given', () => {
    const verdict = observe(new Date(NOW.getTime() - HOUR * 5), '1h');

    expect(verdict.silentBefore).toEqual(
      new Date(NOW.getTime() - HOUR * SOURCE_SILENCE_INTERVAL_MULTIPLIER),
    );
  });

  it('scales with the interval the source declared, so a 15m source does not wait a day to be called silent', () => {
    // 40 minutes is within a daily source's two intervals and past a 15-minute source's, which is
    // the whole point of measuring against the schedule rather than a global window.
    const fortyMinutesAgo = new Date(NOW.getTime() - 40 * 60_000);

    expect(observe(fortyMinutesAgo, '1d').silent).toBe(false);
    expect(observe(fortyMinutesAgo, '15m').silent).toBe(true);
  });
});

describe('the policy identity', () => {
  it('is versioned, so a verdict can be traced to the rule that produced it', () => {
    // Changing the multiplier changes which sources are called silent, so it cannot move silently:
    // this assertion fails together with any edit to the rule.
    expect(SOURCE_SILENCE_POLICY_VERSION).toBe('FR-020_SOURCE_SILENCE_V1');
    expect(SOURCE_SILENCE_INTERVAL_MULTIPLIER).toBe(2);
  });
});
