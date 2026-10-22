import { LifecycleStatus } from '../enums';

/**
 * Deadline-driven lifecycle reconciliation (FR-019, SRS 4.4).
 *
 * The SRS requires expired jobs to be detected and fixes neither the evidence nor a rule, so
 * this policy owns one signal only: the application deadline the source itself stated. It is a
 * pure function of two stored facts and the clock, which is what makes it reproducible
 * (ENG-012) and testable without a database.
 *
 * Ownership is split with `classifyLifecycle` so the two never fight:
 *  - this policy moves `ACTIVE <-> EXPIRED`, and nothing else;
 *  - the listing-presence policy owns `ACTIVE <-> REMOVED`, and nothing else.
 *
 * Neither writes the other's states, so `REMOVED` is never overwritten by a deadline and
 * `EXPIRED` is never overwritten by listing presence. That matters because a policy that
 * re-derives a state from evidence that cannot support it destroys a determination it cannot
 * restore.
 */
export const DEADLINE_POLICY_VERSION = 'DEADLINE_V1';

/** The lifecycle states this policy derives. */
export const DEADLINE_RECONCILED_STATUSES: readonly LifecycleStatus[] = [
  LifecycleStatus.ACTIVE,
  LifecycleStatus.EXPIRED,
];

/**
 * How long a stated deadline stays actionable past UTC midnight of its own day.
 *
 * The shared date parser is date-only and yields UTC midnight, so `30 Oct 2026` stored as
 * `2026-10-30T00:00:00Z` means "the thirtieth is the last day to apply", not "it closed at
 * midnight". A full day of grace keeps the whole stated day actionable, and the three-hour
 * difference between UTC and East Africa Time cannot retire a posting early. A source that
 * states a time of day is not captured at that precision, so the generous reading is the only
 * honest one.
 */
export const DEADLINE_GRACE_MS = 24 * 60 * 60 * 1000;

/** True when the stated deadline can no longer be acted on. Null (UNKNOWN) is never past. */
export function isPastDeadline(applicationDeadline: Date | null, now: Date): boolean {
  if (applicationDeadline === null) return false;
  return now.getTime() >= applicationDeadline.getTime() + DEADLINE_GRACE_MS;
}

export interface DeadlineEvidence {
  /** The Job's current status, as persisted. */
  currentStatus: LifecycleStatus;
  /** The stored deadline, or null when the source stated none this system could read. */
  applicationDeadline: Date | null;
  /** Evaluation time, injected so the decision is reproducible (ENG-012). */
  now: Date;
}

export interface DeadlineDecision {
  /** The status the deadline supports. Equal to `currentStatus` when nothing should change. */
  status: LifecycleStatus;
  /** Why, for the audit trail (nothing in the schema stores a lifecycle reason). */
  reason: string;
}

export function classifyDeadline(evidence: DeadlineEvidence): DeadlineDecision {
  const { currentStatus, applicationDeadline, now } = evidence;

  if (!DEADLINE_RECONCILED_STATUSES.includes(currentStatus)) {
    return {
      status: currentStatus,
      reason: `${currentStatus} is derived from other evidence, not from a stated deadline`,
    };
  }

  if (isPastDeadline(applicationDeadline, now)) {
    const deadline = applicationDeadline as Date;
    return {
      status: LifecycleStatus.EXPIRED,
      reason: `the stated deadline ${deadline.toISOString().slice(0, 10)} has passed`,
    };
  }

  if (applicationDeadline === null) {
    // An EXPIRED job whose stored deadline is gone can no longer be supported by deadline
    // evidence. ACTIVE is what the remaining evidence supports; a job the source no longer
    // publishes is still retired by the listing-presence policy, which owns that signal.
    return {
      status: LifecycleStatus.ACTIVE,
      reason:
        currentStatus === LifecycleStatus.EXPIRED
          ? 'no stated deadline is stored, so the expiry is no longer supported'
          : 'no application deadline is stated',
    };
  }

  return {
    status: LifecycleStatus.ACTIVE,
    reason: `the stated deadline ${applicationDeadline.toISOString().slice(0, 10)} has not passed`,
  };
}
