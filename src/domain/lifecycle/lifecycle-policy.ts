import { LifecycleStatus } from '@domain/enums';

/**
 * Deterministic job lifecycle reconciliation (FR-019, SRS 4.4).
 *
 * The SRS requires expired, removed, and dead jobs to be detected, fixes neither the
 * evidence nor a threshold, and defines no acceptance criterion for FR-019. Of the three
 * states, only **removed** is derivable from persisted evidence, so this policy owns exactly
 * that one signal: a Job is absent from consecutive *informative* collections of its own source.
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
 * **Consecutive misses** (audit L9). One run's silence used to be enough. A source that
 * intermittently truncates a page then retired live Jobs and restored them on the next run,
 * and every flap destroyed that Job's match and notification history. Retirement now needs
 * `LIFECYCLE_MISS_THRESHOLD` consecutive informative collections that could speak for the Job
 * to have missed it. The read model supplies the newest such collection and the one before it
 * (`retirementCutoffRun`): a Job not observed at or after the cutoff's start was missed by the
 * cutoff *and* by the newer run, because a collection that captured it stamps `lastSeenAt` at
 * or after its own start. Runs that could not speak for the Job — failed, empty, or capped
 * above its publication date — are not misses and are skipped rather than counted.
 *
 * `EXPIRED` (a stated deadline) is owned by `@domain/lifecycle/deadline-policy` and
 * `NOT_FOUND` (a dead application target) comes from evidence this system does not hold yet,
 * so both are deliberately left alone here: this policy can never re-derive them, and
 * overwriting them from listing presence would destroy a determination it cannot restore.
 *
 * `ponytail:` the threshold is a fixed constant, not configuration, and it has not been tuned
 * against a real source's truncation rate. Revisit only if a source shows repeated
 * at-the-boundary misses.
 */
export const LIFECYCLE_POLICY_VERSION = 'LIFECYCLE_V3';

/**
 * How many consecutive informative collections must miss a Job before it is retired.
 *
 * Two is the smallest count that separates "the source stopped listing this Job" from "one
 * collection's pages happened to miss it". The read model reads `LIFECYCLE_MISS_THRESHOLD - 1`
 * qualifying runs back, so this constant and the SQL cannot drift apart.
 */
export const LIFECYCLE_MISS_THRESHOLD = 2;

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

/** A run, with the evidence that lets it speak for one Job. */
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
   * covered this Job: it captured the Job, read the whole listing, or read down past the
   * Job's date. Null when no such run exists. Presence is decided against it first, so a Job
   * seen by the newest collection is restored as soon as it reappears.
   */
  newestQualifyingRun: LifecycleRunEvidence | null;
  /**
   * The qualifying run immediately before `newestQualifyingRun`, or null when the source has
   * had only one. Retirement is decided against this run: a Job not observed at or after its
   * start was missed by it and by the newer one, while a Job observed by it has been missed
   * only once and is kept.
   */
  retirementCutoffRun: LifecycleRunEvidence | null;
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
  const {
    currentStatus,
    lastObservedAt,
    publishedAt,
    newestQualifyingRun,
    retirementCutoffRun,
  } = evidence;

  if (!RECONCILED_LIFECYCLE_STATUSES.includes(currentStatus)) {
    return {
      status: currentStatus,
      reason: `${currentStatus} is derived from other evidence, not from listing presence`,
    };
  }
  if (newestQualifyingRun === null) {
    return { status: currentStatus, reason: 'the source has no informative collection yet' };
  }
  if (lastObservedAt === null) {
    return { status: currentStatus, reason: 'the job records no observation time' };
  }

  if (lastObservedAt.getTime() >= newestQualifyingRun.startedAt.getTime()) {
    return {
      status: LifecycleStatus.ACTIVE,
      reason: 'observed by the most recent informative collection of its source',
    };
  }
  if (retirementCutoffRun === null) {
    return {
      status: currentStatus,
      reason:
        'one informative collection has missed the job; retirement needs consecutive misses',
    };
  }
  if (lastObservedAt.getTime() >= retirementCutoffRun.startedAt.getTime()) {
    return {
      status: LifecycleStatus.ACTIVE,
      reason: 'observed by the previous informative collection of its source',
    };
  }
  if (!isInsideCoverage(retirementCutoffRun, publishedAt)) {
    return {
      status: currentStatus,
      reason:
        'the informative collections that could have seen the job did not cover its publication window',
    };
  }
  return {
    status: LifecycleStatus.REMOVED,
    reason:
      'absent from consecutive informative collections that covered its publication window',
  };
}
