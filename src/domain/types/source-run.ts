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
