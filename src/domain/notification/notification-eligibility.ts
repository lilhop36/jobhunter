import { LifecycleStatus } from '../enums';
import {
  hasUsableApplicationPath,
  type NotificationPolicy,
} from '../normalizers/application-target';
import { asPercent } from '../types/numeric-units';
import type { ApplicationTarget } from '../types/normalized-job';
import type { Percent } from '../types/numeric-units';

/**
 * Notification eligibility (FR-016, SRS 3.2, 4.8; AC-015, AC-016).
 *
 * SRS 3.2 states the rule as one conjunction:
 *
 *   ACTIVE
 *   AND usable application target
 *   AND not already notified for equivalent event
 *   AND score >= threshold
 *   AND confidence >= threshold
 *   AND not suppressed/rejected
 *
 * The SRS fixes no threshold values (§4.6 calls weights and thresholds a versioned
 * hypothesis), so `NOTIFICATION_THRESHOLDS_V1` is a proposal, not a derived constant,
 * and it is stamped on every decision. ADR-0006 records it and awaits acceptance, the
 * same way ADR-0005 records the matcher constants.
 *
 * Two deliberate choices:
 *
 *  - **Every failing predicate is reported**, not just the first. A notification that
 *    did not happen is a question the operator will ask, and "score too low" is a
 *    different answer from "no application path". Deterministic order: SRS 3.2 order.
 *  - **Confidence is a real gate, separately from score** (ENG-028, AC-010). The matcher
 *    renormalizes over the factors it could evaluate, so a job with a good role match and
 *    nothing else can reach a high *score* on very little evidence. Job-side skill
 *    extraction does not exist yet (ADR-0005 §2), so Skills is permanently UNKNOWN and
 *    about 30 of the 100 weight points are always missing; a threshold above what that
 *    ceiling permits would silence the system, and a threshold of zero would deliver
 *    guesses. That tension is the reason ADR-0006 exists.
 */
export const NOTIFICATION_ELIGIBILITY_VERSION = '1.0.0';

/** The two numeric knobs of SRS 3.2's eligibility rule. */
export interface NotificationThresholds {
  /** Minimum match score (Percent, inclusive). */
  minScore: Percent;
  /** Minimum match confidence (Percent, inclusive). */
  minConfidence: Percent;
}

/**
 * The v1 hypothesis. See ADR-0006 for the reasoning and the arithmetic behind each
 * number; a change here is a change to notification eligibility (ENG-014) and must
 * carry the same review as a matcher change.
 */
export const NOTIFICATION_THRESHOLDS_V1: Readonly<NotificationThresholds> = {
  minScore: asPercent(60),
  minConfidence: asPercent(50),
};

/** Why a job is not notifiable. One value per SRS 3.2 predicate, in that order. */
export type NotificationIneligibilityReason =
  | 'NOT_ACTIVE'
  | 'NO_USABLE_APPLICATION_PATH'
  | 'ALREADY_NOTIFIED'
  | 'SCORE_BELOW_THRESHOLD'
  | 'CONFIDENCE_BELOW_THRESHOLD'
  | 'REJECTED_BY_USER';

/**
 * Everything SRS 3.2 asks about, already resolved by the caller.
 *
 * `alreadyNotified` and `rejectedByUser` are booleans rather than queries: the outbox
 * event key and the feedback rows are persistence concerns, and a policy that queried
 * them could not be tested without a database or explained without one.
 */
export interface NotificationEligibilityInput {
  lifecycleStatus: LifecycleStatus;
  applicationTarget: ApplicationTarget;
  score: Percent;
  confidence: Percent;
  /** An equivalent event already exists in the outbox (ENG-027 event key). */
  alreadyNotified: boolean;
  /** The user rejected or suppressed this job (feedback NOT_RELEVANT). */
  rejectedByUser: boolean;
}

export interface NotificationEligibilityDecision {
  eligible: boolean;
  /** Every failing predicate, in SRS 3.2 order. Empty when eligible. */
  reasons: readonly NotificationIneligibilityReason[];
  /** Deterministic, evidence-derived text: what passed, or everything that failed. */
  explanation: string;
}

export interface NotificationEligibilityOptions {
  thresholds?: NotificationThresholds;
  /** SRS 3.5: the policy may permit informational listings (AC-004). Off by default. */
  policy?: NotificationPolicy;
}

export function evaluateNotificationEligibility(
  input: NotificationEligibilityInput,
  options: NotificationEligibilityOptions = {},
): NotificationEligibilityDecision {
  const thresholds = options.thresholds ?? NOTIFICATION_THRESHOLDS_V1;
  const reasons: NotificationIneligibilityReason[] = [];
  const lines: string[] = [];

  if (input.lifecycleStatus !== LifecycleStatus.ACTIVE) {
    reasons.push('NOT_ACTIVE');
    lines.push(`job is ${input.lifecycleStatus}, not ACTIVE`);
  }

  if (!hasUsableApplicationPath(input.applicationTarget, options.policy)) {
    reasons.push('NO_USABLE_APPLICATION_PATH');
    lines.push('no usable application path');
  }

  if (input.alreadyNotified) {
    reasons.push('ALREADY_NOTIFIED');
    lines.push('this event was already notified');
  }

  if (input.score < thresholds.minScore) {
    reasons.push('SCORE_BELOW_THRESHOLD');
    lines.push(`score ${input.score} is below the ${thresholds.minScore} threshold`);
  }

  if (input.confidence < thresholds.minConfidence) {
    reasons.push('CONFIDENCE_BELOW_THRESHOLD');
    lines.push(`confidence ${input.confidence} is below the ${thresholds.minConfidence} threshold`);
  }

  if (input.rejectedByUser) {
    reasons.push('REJECTED_BY_USER');
    lines.push('the user rejected or suppressed this job');
  }

  const eligible = reasons.length === 0;
  const explanation = eligible
    ? `eligible: score ${input.score} >= ${thresholds.minScore}, confidence ${input.confidence} >= ${thresholds.minConfidence} (notification eligibility ${NOTIFICATION_ELIGIBILITY_VERSION})`
    : `${lines.join('; ')} (notification eligibility ${NOTIFICATION_ELIGIBILITY_VERSION})`;

  return { eligible, reasons, explanation };
}

/** The v1 notification type and event (SRS 5.2 `notificationType`). */
export const NOTIFICATION_TYPE_NEW_MATCH = 'NEW_MATCH';
export const NOTIFICATION_EVENT_NEW_MATCH = 'NEW_MATCH';
