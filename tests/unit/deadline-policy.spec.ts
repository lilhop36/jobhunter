import { describe, expect, it } from 'vitest';
import { LifecycleStatus } from '@domain/enums';
import {
  DEADLINE_GRACE_MS,
  DEADLINE_POLICY_VERSION,
  classifyDeadline,
  isPastDeadline,
} from '@domain/lifecycle/deadline-policy';

/**
 * The deadline policy (FR-019). Pinned here: the inclusive-day grace, the states the policy
 * owns (and the ones it refuses to touch), and the one restore path — an expiry whose evidence
 * is gone or has moved forward must not outlive its evidence.
 */

describe('isPastDeadline', () => {
  const DEADLINE = new Date('2026-10-30T00:00:00.000Z');

  it('is false when no deadline is stored (UNKNOWN is never negative evidence)', () => {
    expect(isPastDeadline(null, new Date('2030-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('keeps the whole stated day actionable (date-only input, UTC midnight)', () => {
    expect(isPastDeadline(DEADLINE, new Date('2026-10-30T00:00:00.000Z'))).toBe(false);
    expect(isPastDeadline(DEADLINE, new Date('2026-10-30T23:59:59.999Z'))).toBe(false);
    expect(isPastDeadline(DEADLINE, new Date('2026-10-31T00:00:00.000Z'))).toBe(true);
  });

  it('is true well after the deadline and false before it', () => {
    expect(isPastDeadline(DEADLINE, new Date('2026-11-05T00:00:00.000Z'))).toBe(true);
    expect(isPastDeadline(DEADLINE, new Date('2026-10-29T23:00:00.000Z'))).toBe(false);
  });

  it('grants exactly one day of grace, not more', () => {
    expect(DEADLINE_GRACE_MS).toBe(24 * 60 * 60 * 1000);
    const endOfStatedDayMs = DEADLINE.getTime() + DEADLINE_GRACE_MS;
    expect(isPastDeadline(DEADLINE, new Date(endOfStatedDayMs - 1))).toBe(false);
    expect(isPastDeadline(DEADLINE, new Date(endOfStatedDayMs))).toBe(true);
  });
});

describe('classifyDeadline', () => {
  const NOW = new Date('2026-11-01T00:00:00.000Z');

  it('expires an ACTIVE job whose deadline has passed', () => {
    const decision = classifyDeadline({
      currentStatus: LifecycleStatus.ACTIVE,
      applicationDeadline: new Date('2026-10-30T00:00:00.000Z'),
      now: NOW,
    });
    expect(decision.status).toBe(LifecycleStatus.EXPIRED);
    expect(decision.reason).toContain('2026-10-30');
  });

  it('keeps a stated deadline day actionable (inclusive day, not midnight)', () => {
    const decision = classifyDeadline({
      currentStatus: LifecycleStatus.ACTIVE,
      applicationDeadline: new Date('2026-10-30T00:00:00.000Z'),
      now: new Date('2026-10-30T21:00:00.000Z'), // 23:59 in East Africa Time
    });
    expect(decision.status).toBe(LifecycleStatus.ACTIVE);
  });

  it('keeps an ACTIVE job with no deadline exactly as it is', () => {
    const decision = classifyDeadline({
      currentStatus: LifecycleStatus.ACTIVE,
      applicationDeadline: null,
      now: NOW,
    });
    expect(decision.status).toBe(LifecycleStatus.ACTIVE);
  });

  it('restores an EXPIRED job when its deadline moved forward', () => {
    const decision = classifyDeadline({
      currentStatus: LifecycleStatus.EXPIRED,
      applicationDeadline: new Date('2027-01-01T00:00:00.000Z'),
      now: NOW,
    });
    expect(decision.status).toBe(LifecycleStatus.ACTIVE);
    expect(decision.reason).toContain('has not passed');
  });

  it('restores an EXPIRED job whose deadline evidence is gone', () => {
    const decision = classifyDeadline({
      currentStatus: LifecycleStatus.EXPIRED,
      applicationDeadline: null,
      now: NOW,
    });
    expect(decision.status).toBe(LifecycleStatus.ACTIVE);
    expect(decision.reason).toContain('no longer supported');
  });

  it('never moves a status another policy derived, even with a long-past deadline', () => {
    for (const status of [LifecycleStatus.REMOVED, LifecycleStatus.NOT_FOUND]) {
      const decision = classifyDeadline({
        currentStatus: status,
        applicationDeadline: new Date('2020-01-01T00:00:00.000Z'),
        now: NOW,
      });
      expect(decision.status).toBe(status);
      expect(decision.reason).toContain('other evidence');
    }
  });

  it('reports the version constant', () => {
    expect(DEADLINE_POLICY_VERSION).toBe('DEADLINE_V1');
  });
});
