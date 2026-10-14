import { LifecycleStatus } from '@domain/enums';
import {
  LIFECYCLE_POLICY_VERSION,
  classifyLifecycle,
} from '@domain/lifecycle/lifecycle-policy';

const RUN = new Date('2026-05-01T00:00:00.000Z');
const BEFORE_RUN = new Date('2026-04-30T23:59:59.000Z');
const AFTER_RUN = new Date('2026-05-01T00:00:01.000Z');

function classify(
  currentStatus: LifecycleStatus,
  lastObservedAt: Date | null,
  latestQualifyingRunStartedAt: Date | null = RUN,
) {
  return classifyLifecycle({ currentStatus, lastObservedAt, latestQualifyingRunStartedAt });
}

describe('classifyLifecycle', () => {
  it('retires a job absent from a newer informative collection', () => {
    expect(classify(LifecycleStatus.ACTIVE, BEFORE_RUN).status).toBe(LifecycleStatus.REMOVED);
  });

  it('keeps a job observed by the newest informative collection active', () => {
    expect(classify(LifecycleStatus.ACTIVE, AFTER_RUN).status).toBe(LifecycleStatus.ACTIVE);
  });

  it('treats a capture stamped at the run start as observed', () => {
    expect(classify(LifecycleStatus.ACTIVE, RUN).status).toBe(LifecycleStatus.ACTIVE);
  });

  it('restores a retired job that is published again', () => {
    expect(classify(LifecycleStatus.REMOVED, AFTER_RUN).status).toBe(LifecycleStatus.ACTIVE);
  });

  it('leaves a retired job retired while it stays absent', () => {
    expect(classify(LifecycleStatus.REMOVED, BEFORE_RUN).status).toBe(LifecycleStatus.REMOVED);
  });

  it('concludes nothing without an informative collection', () => {
    // A source that has never run, or whose only runs failed or found nothing, is no
    // evidence of absence (SRS 3.5 / AC-018).
    expect(classify(LifecycleStatus.ACTIVE, BEFORE_RUN, null).status).toBe(LifecycleStatus.ACTIVE);
    expect(classify(LifecycleStatus.REMOVED, BEFORE_RUN, null).status).toBe(LifecycleStatus.REMOVED);
  });

  it('concludes nothing when the job records no observation time', () => {
    expect(classify(LifecycleStatus.ACTIVE, null).status).toBe(LifecycleStatus.ACTIVE);
    expect(classify(LifecycleStatus.REMOVED, null).status).toBe(LifecycleStatus.REMOVED);
  });

  it('never reconciles a status derived from other evidence', () => {
    // EXPIRED needs a deadline and NOT_FOUND a dead application target; listing presence
    // cannot re-derive either, so this policy must not overwrite them.
    for (const status of [LifecycleStatus.EXPIRED, LifecycleStatus.NOT_FOUND]) {
      expect(classify(status, BEFORE_RUN).status).toBe(status);
      expect(classify(status, AFTER_RUN).status).toBe(status);
    }
  });

  it('explains every decision', () => {
    expect(classify(LifecycleStatus.ACTIVE, BEFORE_RUN).reason).toContain('absent');
    expect(classify(LifecycleStatus.ACTIVE, AFTER_RUN).reason).toContain('observed');
    expect(classify(LifecycleStatus.EXPIRED, BEFORE_RUN).reason).toContain('other evidence');
  });

  it('stamps a policy version', () => {
    expect(LIFECYCLE_POLICY_VERSION).toBe('LIFECYCLE_V1');
  });
});
