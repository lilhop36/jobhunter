import { SourceRunStatus, SourceRunTrigger } from '../enums';

/**
 * A collection run as observed by the application layer. Mirrors `source_runs`
 * without leaking persistence concerns.
 *
 * The counter fields are the funnel recorded by SRS 7.8
 * (`collected -> parsed -> valid -> unique -> active -> matched -> notified`); the
 * run owns the first half (everything up to and including deduplication).
 */
export interface SourceRunRecord {
  id: string;
  sourceId: string;
  status: SourceRunStatus;
  trigger: SourceRunTrigger;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  jobsDiscovered: number;
  jobsAccepted: number;
  jobsDuplicate: number;
  jobsRejected: number;
  /**
   * Records whose identity could not be resolved: preserved as raw evidence but not
   * promoted to a Job (ADR-0001 concept 1). Not derivable from the counters above - the
   * funnel `parsed = unique + jobsDuplicate + jobsRejected + undeduplicable` does not
   * close without it.
   */
  undeduplicable: number;
  /** Records whose resolved identity rests on the weakest (`fp:`) basis (ADR-0001 limitation). */
  fallbackIdentities: number;
  parseFailures: number;
  httpFailures: number;
  unexpectedZeroResults: boolean;
  /**
   * Whether the run read its source's listing to the end. Only such a run is evidence that
   * a record it did not observe is no longer published (FR-019). A capped run can still
   * support retirement inside its narrower coverage window (see `oldestListingPublishedAt`).
   */
  catalogueExhausted: boolean;
  /**
   * Oldest publication date among the listing entries this run read, or null when it made no
   * window claim. An unobserved record published strictly after this floor was inside the
   * window the run saw; records at or before it may lie beyond the pages read (FR-019).
   */
  oldestListingPublishedAt: Date | null;
  /**
   * Whether this run scheduled downstream enrichment/matching work (SRS 7.7 step 10).
   * Recorded explicitly so a `SUCCEEDED` status never implies step 10 ran.
   */
  enrichmentScheduled: boolean;
  /**
   * Last time this run proved itself still working (audit M2): written when the run opens and
   * again as the collection loop advances. It is what lets the recovery sweep tell a run that
   * is merely slow from one whose worker is gone, instead of inferring death from `startedAt`.
   *
   * Null means the run never stamped one - only rows written before the column existed - so
   * its start time is the only liveness evidence available for it.
   */
  lastHeartbeatAt: Date | null;
  errorSummary: string | null;
}

/**
 * Statuses for which a source may hold at most one run - i.e. the run is either in
 * progress or being finalized. Must match the predicate of the
 * `one_active_run_per_source` partial index.
 */
export const ACTIVE_SOURCE_RUN_STATUSES: readonly SourceRunStatus[] = [SourceRunStatus.RUNNING];

/**
 * Value recorded in `errorSummary` when the reaper reclaims a run whose worker
 * died mid-run (ENG-025). A run that is still RUNNING after the configured maximum
 * duration is treated as abandoned, which keeps the one-active-run-per-source
 * constraint from wedging a source forever after a crash.
 *
 * The name outlived its first implementation: since M2 the sweep judges a run by how long it
 * has been *silent*, not by how long it has existed, so a run that is alive and working is not
 * abandoned however long it takes. The reason text is kept - it is what an operator sees, and
 * "the worker stopped reporting" is still the accurate description of a reclaimed run.
 */
export const SOURCE_RUN_LEASE_EXPIRED_REASON = 'LEASE_EXPIRED';

/**
 * How often a live collection run restates that it is alive (audit M2), in milliseconds - the
 * ceiling the effective interval is taken from, not a promise about it.
 *
 * One minute is well inside every configured stale window (the deployed one is 900 s), so a
 * working run is never mistaken for a dead one, while a dead one is still reclaimed within one
 * window of its last real activity.
 */
export const DEFAULT_SOURCE_RUN_HEARTBEAT_MS = 60_000;

/**
 * The interval at which a collection run must report, given its stale window and whatever the
 * caller asked for (audit M2).
 *
 * The stale window is the period of *silence* after which a run is presumed dead, so a beat that
 * cannot occur inside it defeats the whole signal: a live run would be reclaimed before it ever
 * got to prove itself. An explicit interval that fails that test is therefore refused rather
 * than quietly shortened - a misconfigured safety bound should stop the process, not silently
 * change recovery behaviour.
 *
 * The default adapts instead, for the obvious reason that it was never chosen by anyone: half
 * the window guarantees at least two reports per window even where a test or an operator uses a
 * window shorter than a minute.
 */
export function resolveSourceRunHeartbeatMs(
  staleRunSeconds: number,
  requestedMs?: number,
): number {
  const windowMs = staleRunSeconds * 1000;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(
      `staleRunSeconds must be a positive number of seconds; received ${String(staleRunSeconds)}`,
    );
  }
  if (requestedMs === undefined) {
    return Math.min(DEFAULT_SOURCE_RUN_HEARTBEAT_MS, windowMs / 2);
  }
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) {
    throw new RangeError(
      `source run heartbeat interval must be a positive number of milliseconds; received ${String(requestedMs)}`,
    );
  }
  if (requestedMs >= windowMs) {
    throw new RangeError(
      `source run heartbeat interval (${requestedMs}ms) must be shorter than the ` +
        `${staleRunSeconds}s stale window (${windowMs}ms): a run could be reclaimed as abandoned ` +
        'before it had a chance to report that it is still working',
    );
  }
  return requestedMs;
}

/**
 * What a source's operator has declared about how many results it normally yields
 * (ADR-0001 section 4). Used only to decide whether an empty run is *unexpected*.
 *
 * The SRS requires that unexpected zero-result runs are visible (AC-018) without requiring
 * every empty run to be treated as a fault, so the default is UNKNOWN and raises nothing:
 * the absence of an expectation is not evidence of breakage (ENG-001).
 */
export enum SourceResultExpectation {
  /** No expectation recorded. An empty run is recorded as SUCCEEDED and raises no signal. */
  UNKNOWN = 'UNKNOWN',
  /** The source normally yields results. An empty run is flagged as unexpected. */
  RESULTS_EXPECTED = 'RESULTS_EXPECTED',
  /** The source may legitimately yield nothing. An empty run is normal. */
  ZERO_EXPECTED = 'ZERO_EXPECTED',
}

/**
 * Whether a run that collected nothing must be reported as unexpected (ADR-0001 section 4).
 *
 * Only `RESULTS_EXPECTED` can flag it. `UNKNOWN` deliberately does not: a source whose
 * expected behaviour is unknown must not be reported as broken, or the signal stops being
 * trusted exactly when it matters.
 */
export function isUnexpectedZeroResult(
  collected: number,
  expectation: SourceResultExpectation,
): boolean {
  return collected === 0 && expectation === SourceResultExpectation.RESULTS_EXPECTED;
}
