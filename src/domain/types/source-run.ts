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
 */
export const SOURCE_RUN_LEASE_EXPIRED_REASON = 'LEASE_EXPIRED';

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
