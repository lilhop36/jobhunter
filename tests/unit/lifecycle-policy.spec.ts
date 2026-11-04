import { LifecycleStatus } from '@domain/enums';
import {
  LIFECYCLE_MISS_THRESHOLD,
  LIFECYCLE_POLICY_VERSION,
  classifyLifecycle,
  type LifecycleRunEvidence,
} from '@domain/lifecycle/lifecycle-policy';

const PREV_RUN_AT = new Date('2026-04-01T00:00:00.000Z');
const RUN_AT = new Date('2026-05-01T00:00:00.000Z');
/** Before both collections: the Job was missed by both. */
const BEFORE_PREV_RUN = new Date('2026-03-31T23:59:59.000Z');
/** After the previous collection but before the newest: one miss so far. */
const BETWEEN_RUNS = new Date('2026-04-15T00:00:00.000Z');
const AFTER_RUN = new Date('2026-05-01T00:00:01.000Z');
const WINDOW_FLOOR = new Date('2026-03-15T00:00:00.000Z');

/** A run that read the whole listing: every unobserved Job is in scope. */
const FULL_RUN: LifecycleRunEvidence = {
  startedAt: RUN_AT,
  catalogueExhausted: true,
  oldestListingPublishedAt: null,
};

const PREV_FULL_RUN: LifecycleRunEvidence = { ...FULL_RUN, startedAt: PREV_RUN_AT };

/** A capped run that read the listing down to WINDOW_FLOOR. */
const WINDOW_RUN: LifecycleRunEvidence = {
  startedAt: RUN_AT,
  catalogueExhausted: false,
  oldestListingPublishedAt: WINDOW_FLOOR,
};

const PREV_WINDOW_RUN: LifecycleRunEvidence = { ...WINDOW_RUN, startedAt: PREV_RUN_AT };

function classify(
  currentStatus: LifecycleStatus,
  lastObservedAt: Date | null,
  newestQualifyingRun: LifecycleRunEvidence | null = FULL_RUN,
  retirementCutoffRun: LifecycleRunEvidence | null = PREV_FULL_RUN,
  publishedAt: Date | null = BEFORE_PREV_RUN,
) {
  return classifyLifecycle({
    currentStatus,
    lastObservedAt,
    publishedAt,
    newestQualifyingRun,
    retirementCutoffRun,
  });
}

describe('classifyLifecycle', () => {
  it('retires a job both fully-read informative collections missed', () => {
    expect(classify(LifecycleStatus.ACTIVE, BEFORE_PREV_RUN).status).toBe(LifecycleStatus.REMOVED);
  });

  it('keeps a job observed by the newest informative collection active', () => {
    expect(classify(LifecycleStatus.ACTIVE, AFTER_RUN).status).toBe(LifecycleStatus.ACTIVE);
  });

  it('treats a capture stamped at the run start as observed', () => {
    expect(classify(LifecycleStatus.ACTIVE, RUN_AT).status).toBe(LifecycleStatus.ACTIVE);
  });

  it('keeps a job missed once but observed by the previous collection', () => {
    // One miss is not enough: the source may simply have truncated a page (audit L9).
    const decision = classify(LifecycleStatus.ACTIVE, BETWEEN_RUNS);
    expect(decision.status).toBe(LifecycleStatus.ACTIVE);
    expect(decision.reason).toContain('previous');
  });

  it('keeps a job when only one informative collection exists', () => {
    // No second collection can confirm the absence, and flapping is destructive.
    expect(classify(LifecycleStatus.ACTIVE, BEFORE_PREV_RUN, FULL_RUN, null).status).toBe(
      LifecycleStatus.ACTIVE,
    );
  });

  it('restores a retired job that is observed again despite earlier misses', () => {
    expect(classify(LifecycleStatus.REMOVED, AFTER_RUN).status).toBe(LifecycleStatus.ACTIVE);
  });

  it('leaves a retired job retired while it stays absent', () => {
    expect(classify(LifecycleStatus.REMOVED, BEFORE_PREV_RUN).status).toBe(LifecycleStatus.REMOVED);
  });

  it('concludes nothing without an informative collection', () => {
    // A source that has never run, or whose only runs failed or found nothing, is no
    // evidence of absence (SRS 3.5 / AC-018).
    expect(classify(LifecycleStatus.ACTIVE, BEFORE_PREV_RUN, null, null).status).toBe(
      LifecycleStatus.ACTIVE,
    );
    expect(classify(LifecycleStatus.REMOVED, BEFORE_PREV_RUN, null, null).status).toBe(
      LifecycleStatus.REMOVED,
    );
  });

  it('concludes nothing when the job records no observation time', () => {
    expect(classify(LifecycleStatus.ACTIVE, null).status).toBe(LifecycleStatus.ACTIVE);
    expect(classify(LifecycleStatus.REMOVED, null).status).toBe(LifecycleStatus.REMOVED);
  });

  it('never reconciles a status derived from other evidence', () => {
    // EXPIRED needs a deadline and NOT_FOUND a dead application target; listing presence
    // cannot re-derive either, so this policy must not overwrite them.
    for (const status of [LifecycleStatus.EXPIRED, LifecycleStatus.NOT_FOUND]) {
      expect(classify(status, BEFORE_PREV_RUN).status).toBe(status);
      expect(classify(status, AFTER_RUN).status).toBe(status);
    }
  });

  it('explains every decision', () => {
    expect(classify(LifecycleStatus.ACTIVE, BEFORE_PREV_RUN).reason).toContain('absent');
    expect(classify(LifecycleStatus.ACTIVE, AFTER_RUN).reason).toContain('observed');
    expect(classify(LifecycleStatus.EXPIRED, BEFORE_PREV_RUN).reason).toContain('other evidence');
  });

  it('stamps a policy version and the miss threshold it enforces', () => {
    // V2 added the coverage window, V3 the consecutive-miss requirement: a log carrying an
    // older version was produced by a rule that could retire on one miss.
    expect(LIFECYCLE_POLICY_VERSION).toBe('LIFECYCLE_V3');
    expect(LIFECYCLE_MISS_THRESHOLD).toBe(2);
  });
});

describe('classifyLifecycle — capped-run coverage window', () => {
  const IN_WINDOW = new Date('2026-03-20T00:00:00.000Z');
  const ON_FLOOR = WINDOW_FLOOR;
  const OUTSIDE_WINDOW = new Date('2026-03-01T00:00:00.000Z');

  it('retires an unobserved job published inside the window both runs read', () => {
    expect(
      classify(LifecycleStatus.ACTIVE, BEFORE_PREV_RUN, WINDOW_RUN, PREV_WINDOW_RUN, IN_WINDOW)
        .status,
    ).toBe(LifecycleStatus.REMOVED);
  });

  it('does not retire a job published on the window floor', () => {
    // Published dates are date-only: an equally-dated entry may be on the unread next page.
    expect(
      classify(LifecycleStatus.ACTIVE, BEFORE_PREV_RUN, WINDOW_RUN, PREV_WINDOW_RUN, ON_FLOOR)
        .status,
    ).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not retire a job older than the window', () => {
    // It may still be published, further down the listing than either run read.
    expect(
      classify(
        LifecycleStatus.ACTIVE,
        BEFORE_PREV_RUN,
        WINDOW_RUN,
        PREV_WINDOW_RUN,
        OUTSIDE_WINDOW,
      ).status,
    ).toBe(LifecycleStatus.ACTIVE);
    expect(
      classify(
        LifecycleStatus.REMOVED,
        BEFORE_PREV_RUN,
        WINDOW_RUN,
        PREV_WINDOW_RUN,
        OUTSIDE_WINDOW,
      ).status,
    ).toBe(LifecycleStatus.REMOVED);
  });

  it('does not retire a job with no publication date', () => {
    // Without a date the job cannot be placed inside the window.
    expect(
      classify(LifecycleStatus.ACTIVE, BEFORE_PREV_RUN, WINDOW_RUN, PREV_WINDOW_RUN, null).status,
    ).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not retire from a cutoff run that made no window claim', () => {
    const NO_CLAIM: LifecycleRunEvidence = {
      startedAt: PREV_RUN_AT,
      catalogueExhausted: false,
      oldestListingPublishedAt: null,
    };
    expect(
      classify(LifecycleStatus.ACTIVE, BEFORE_PREV_RUN, WINDOW_RUN, NO_CLAIM, IN_WINDOW).status,
    ).toBe(LifecycleStatus.ACTIVE);
  });

  it('restores an observed job regardless of the window', () => {
    expect(
      classify(LifecycleStatus.REMOVED, AFTER_RUN, WINDOW_RUN, PREV_WINDOW_RUN, OUTSIDE_WINDOW)
        .status,
    ).toBe(LifecycleStatus.ACTIVE);
  });
});
