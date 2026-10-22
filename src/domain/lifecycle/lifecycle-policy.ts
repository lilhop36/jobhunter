import { LifecycleStatus } from '@domain/enums';

/**
 * Deterministic job lifecycle reconciliation (FR-019, SRS 4.4).
 *
 * The SRS requires expired, removed, and dead jobs to be detected, fixes neither the
 * evidence nor a threshold, and defines no acceptance criterion for FR-019. Of the three
 * states, only **removed** is derivable from persisted evidence, so this policy owns exactly
 * that one signal: a Job is absent from a newer *informative* collection of its own source.
 *
 * "Informative" is the load-bearing word. Only a `SUCCEEDED` run that discovered at least
 * one record counts, because:
 *   - a failed or partially-completed collection says nothing about what the source still
 *     publishes (absence of evidence), and
 *   - a successful zero-result run is the SRS 3.5 / AC-018 anomaly signal, not proof that
 *     every listing disappeared. Reading it as proof would mass-retire a healthy source's
 *     whole catalogue.
 *
 * The rule is threshold-free: it compares the Job's last observation against the source's
 * most recent informative run rather than counting missed runs or days, so there is no
 * tunable constant to misconfigure. `EXPIRED` (a stated deadline) is owned by
 * `@domain/lifecycle/deadline-policy` and `NOT_FOUND` (a dead application target) comes from
 * evidence this system does not hold yet, so both are deliberately left alone here: this
 * policy can never re-derive them, and overwriting them from listing presence would destroy a
 * determination it cannot restore.
 *
 * `ponytail:` a single missed run is enough to retire a Job. A source that intermittently
 * truncates its listing will flap. Add a consecutive-miss requirement (and a policy version
 * bump) only once a real source shows that behaviour.
 */
export const LIFECYCLE_POLICY_VERSION = 'LIFECYCLE_V1';

/** The lifecycle states this policy derives. */
export const RECONCILED_LIFECYCLE_STATUSES: readonly LifecycleStatus[] = [
  LifecycleStatus.ACTIVE,
  LifecycleStatus.REMOVED,
];

export interface LifecycleEvidence {
  /** The Job's current status, as persisted. */
  currentStatus: LifecycleStatus;
  /**
   * `RawJob.lastSeenAt` of the Job's newest capture: when the source last published this
   * record. `null` when that capture no longer exists, in which case nothing can be
   * concluded (a lower bound would make retirement *more* likely, which is the unsafe
   * direction).
   */
  lastObservedAt: Date | null;
  /**
   * Start of the source's most recent informative run, or `null` when it has none. Compared
   * against `lastObservedAt`: a capture stamped during a run is always at or after its start.
   */
  latestQualifyingRunStartedAt: Date | null;
}

export interface LifecycleDecision {
  /** The status the evidence supports. Equal to `currentStatus` when nothing should change. */
  status: LifecycleStatus;
  /** Why, for the audit trail (nothing in the schema stores a lifecycle reason). */
  reason: string;
}

export function classifyLifecycle(evidence: LifecycleEvidence): LifecycleDecision {
  const { currentStatus, lastObservedAt, latestQualifyingRunStartedAt } = evidence;

  if (!RECONCILED_LIFECYCLE_STATUSES.includes(currentStatus)) {
    return {
      status: currentStatus,
      reason: `${currentStatus} is derived from other evidence, not from listing presence`,
    };
  }
  if (latestQualifyingRunStartedAt === null) {
    return { status: currentStatus, reason: 'the source has no informative collection yet' };
  }
  if (lastObservedAt === null) {
    return { status: currentStatus, reason: 'the job records no observation time' };
  }

  if (lastObservedAt.getTime() >= latestQualifyingRunStartedAt.getTime()) {
    return {
      status: LifecycleStatus.ACTIVE,
      reason: 'observed by the most recent informative collection of its source',
    };
  }
  return {
    status: LifecycleStatus.REMOVED,
    reason: 'absent from the most recent informative collection of its source',
  };
}
