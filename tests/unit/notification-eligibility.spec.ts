import { describe, expect, it } from 'vitest';
import { ApplicationMethod, LifecycleStatus } from '@domain/enums';
import {
  NOTIFICATION_ELIGIBILITY_VERSION,
  NOTIFICATION_THRESHOLDS_V1,
  evaluateNotificationEligibility,
  type NotificationEligibilityInput,
} from '@domain/notification';
import { asPercent } from '@domain/types';

/**
 * SRS 3.2 notification eligibility, as one conjunction. These cases pin each predicate
 * independently (so a regression names itself), the inclusive boundary, and the rule that
 * confidence gates separately from score (ENG-028) — a high score built on thin evidence
 * must not be notifiable.
 */

function input(overrides: Partial<NotificationEligibilityInput> = {}): NotificationEligibilityInput {
  return {
    lifecycleStatus: LifecycleStatus.ACTIVE,
    applicationTarget: {
      method: ApplicationMethod.ONLINE_URL,
      applyUrl: 'https://example.test/apply',
      applyEmail: null,
      evidence: 'apply at https://example.test/apply',
    },
    score: asPercent(80),
    confidence: asPercent(60),
    alreadyNotified: false,
    rejectedByUser: false,
    ...overrides,
  };
}

describe('notification eligibility (SRS 3.2)', () => {
  it('is eligible when every predicate holds', () => {
    const decision = evaluateNotificationEligibility(input());

    expect(decision.eligible).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.explanation).toContain('eligible');
    expect(decision.explanation).toContain(NOTIFICATION_ELIGIBILITY_VERSION);
  });

  it('is not eligible for a job that is not ACTIVE', () => {
    for (const status of [
      LifecycleStatus.EXPIRED,
      LifecycleStatus.REMOVED,
      LifecycleStatus.NOT_FOUND,
    ]) {
      const decision = evaluateNotificationEligibility(input({ lifecycleStatus: status }));

      expect(decision.eligible).toBe(false);
      expect(decision.reasons).toEqual(['NOT_ACTIVE']);
      expect(decision.explanation).toContain(status);
    }
  });

  it('is not eligible without a usable application path (AC-004)', () => {
    const decision = evaluateNotificationEligibility(
      input({
        applicationTarget: {
          method: ApplicationMethod.UNKNOWN,
          applyUrl: null,
          applyEmail: null,
          evidence: null,
        },
      }),
    );

    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual(['NO_USABLE_APPLICATION_PATH']);
  });

  it('follows a policy that permits informational listings', () => {
    const decision = evaluateNotificationEligibility(
      input({
        applicationTarget: {
          method: ApplicationMethod.UNKNOWN,
          applyUrl: null,
          applyEmail: null,
          evidence: null,
        },
      }),
      { policy: { allowInformationalListings: true } },
    );

    expect(decision.eligible).toBe(true);
  });

  it('is not eligible for an equivalent event that was already notified (AC-016)', () => {
    const decision = evaluateNotificationEligibility(input({ alreadyNotified: true }));

    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual(['ALREADY_NOTIFIED']);
  });

  it('is not eligible below the score threshold, and names the numbers', () => {
    const decision = evaluateNotificationEligibility(input({ score: asPercent(59) }));

    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual(['SCORE_BELOW_THRESHOLD']);
    expect(decision.explanation).toContain('59');
    expect(decision.explanation).toContain('60');
  });

  it('is not eligible below the confidence threshold, and names the numbers', () => {
    const decision = evaluateNotificationEligibility(input({ confidence: asPercent(49) }));

    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual(['CONFIDENCE_BELOW_THRESHOLD']);
    expect(decision.explanation).toContain('49');
    expect(decision.explanation).toContain('50');
  });

  it('treats both thresholds as inclusive (SRS "score >= threshold")', () => {
    const decision = evaluateNotificationEligibility(
      input({
        score: NOTIFICATION_THRESHOLDS_V1.minScore,
        confidence: NOTIFICATION_THRESHOLDS_V1.minConfidence,
      }),
    );

    expect(decision.eligible).toBe(true);
  });

  it('gates a high score with thin evidence on confidence, not score (ENG-028)', () => {
    // A job with a strong role match and little else: relevance is high, evidence is not.
    const decision = evaluateNotificationEligibility(
      input({ score: asPercent(95), confidence: asPercent(20) }),
    );

    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual(['CONFIDENCE_BELOW_THRESHOLD']);
  });

  it('is not eligible for a job the user rejected or suppressed', () => {
    const decision = evaluateNotificationEligibility(input({ rejectedByUser: true }));

    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual(['REJECTED_BY_USER']);
  });

  it('reports every failing predicate, in SRS 3.2 order', () => {
    const decision = evaluateNotificationEligibility(
      input({
        lifecycleStatus: LifecycleStatus.EXPIRED,
        applicationTarget: {
          method: ApplicationMethod.UNKNOWN,
          applyUrl: null,
          applyEmail: null,
          evidence: null,
        },
        score: asPercent(10),
        confidence: asPercent(10),
        alreadyNotified: true,
        rejectedByUser: true,
      }),
    );

    expect(decision.reasons).toEqual([
      'NOT_ACTIVE',
      'NO_USABLE_APPLICATION_PATH',
      'ALREADY_NOTIFIED',
      'SCORE_BELOW_THRESHOLD',
      'CONFIDENCE_BELOW_THRESHOLD',
      'REJECTED_BY_USER',
    ]);
    expect(decision.eligible).toBe(false);
  });

  it('honours thresholds supplied by the caller', () => {
    const decision = evaluateNotificationEligibility(input({ score: asPercent(80) }), {
      thresholds: { minScore: asPercent(85), minConfidence: asPercent(50) },
    });

    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual(['SCORE_BELOW_THRESHOLD']);
  });

  it('is deterministic: the same input yields the same decision', () => {
    expect(evaluateNotificationEligibility(input())).toEqual(evaluateNotificationEligibility(input()));
  });
});
