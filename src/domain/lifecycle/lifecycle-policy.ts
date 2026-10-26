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
 * **What the run covered.** A source's archive is far larger than one polite run may read
 * (the three approved sources paginate over 84, 94 and 126 listing pages at two, two and one
 * page per run). A run therefore rarely sees the whole listing, and "not observed" is only
 * evidence for the part it *did* see. Each run reports a coverage claim:
 *   - `catalogueExhausted`: it read the listing to the end, so every unobserved Job is gone;
 *   - `oldestListingPublishedAt`: the oldest publication date among the entries it read, so
 *     an unobserved Job published *strictly after* that floor was inside the window it saw.
 *     The floor date itself is excluded because published dates are date-only and a page
 *     boundary can split a day: an equally-dated entry may sit on the unread next page.
 *
 * A Job outside the window is left alone, not treated as live: the run simply has no
 * evidence about it. That distinction is why an old Job falling off the read pages is never
 * retired (ENG-001: no evidence is not negative evidence).
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
export const LIFECYCLE_POLICY_VERSION = 'LIFECYCLE_V2';

/** The lifecycle states this policy derives. */
export const RECONCILED_LIFECYCLE_STATUSES: readonly LifecycleStatus[] = [
  LifecycleStatus.ACTIVE,
  LifecycleStatus.REMOVED,
];

/** What one collection run can say about the part of the listing it read. */
export interface LifecycleRunCoverage {
  /** True when the run read its source's listing to the end. */
  catalogueExhausted: boolean;
  /**
   * Oldest publication date among the listing entries the run read, or null when the run
   * made no window claim (an entry was unreadable or undated, or the run was cut short).
   * Only used when `catalogueExhausted` is false.
   */
  oldestListingPublishedAt: Date | null;
}

/** The source's most recent run that can support a retirement decision. */
export interface LifecycleRunEvidence extends LifecycleRunCoverage {
  /** Run start. A capture stamped during the run is always at or after this instant. */
  startedAt: Date;
}

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
   * The Job's publication date, or null when the source evidence yielded none. A Job with
   * no publication date cannot be placed inside a coverage window, so only a fully-read
   * listing can retire it.
   */
  publishedAt: Date | null;
  /**
   * The source's most recent run that is SUCCEEDED, discovered at least one record, and
   * covered this Job: it read the whole listing, or its publication-date floor is below the
   * Job's date. Null when no such run exists.
   */
  latestQualifyingRun: LifecycleRunEvidence | null;
}

export interface LifecycleDecision {
  /** The status the evidence supports. Equal to `currentStatus` when nothing should change. */
  status: LifecycleStatus;
  /** Why, for the audit trail (nothing in the schema stores a lifecycle reason). */
  reason: string;
}

/** Whether an unobserved Job's publication date falls inside what the run read. */
function isInsideCoverage(run: LifecycleRunEvidence, publishedAt: Date | null): boolean {
  if (run.catalogueExhausted) return true;
  if (publishedAt === null || run.oldestListingPublishedAt === null) return false;
  // Strictly after: published dates are date-only, so an entry equal to the floor may have
  // been listed after the last entry the run read.
  return publishedAt.getTime() > run.oldestListingPublishedAt.getTime();
}

export function classifyLifecycle(evidence: LifecycleEvidence): LifecycleDecision {
  const { currentStatus, lastObservedAt, publishedAt, latestQualifyingRun } = evidence;

  if (!RECONCILED_LIFECYCLE_STATUSES.includes(currentStatus)) {
    return {
      status: currentStatus,
      reason: `${currentStatus} is derived from other evidence, not from listing presence`,
    };
  }
  if (latestQualifyingRun === null) {
    return { status: currentStatus, reason: 'the source has no informative collection yet' };
  }
  if (lastObservedAt === null) {
    return { status: currentStatus, reason: 'the job records no observation time' };
  }

  if (lastObservedAt.getTime() >= latestQualifyingRun.startedAt.getTime()) {
    return {
      status: LifecycleStatus.ACTIVE,
      reason: 'observed by the most recent informative collection of its source',
    };
  }
  if (!isInsideCoverage(latestQualifyingRun, publishedAt)) {
    return {
      status: currentStatus,
      reason:
        'the most recent informative collection did not cover the job’s publication window',
    };
  }
  return {
    status: LifecycleStatus.REMOVED,
    reason: 'absent from the covered window of the most recent informative collection',
  };
}
