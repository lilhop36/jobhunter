import { SourceRunStatus, SourceRunTrigger } from '@domain/enums';
import { SourceRunRecord } from '@domain/types';

export interface StartSourceRunInput {
  sourceId: string;
  /** Defaults to SCHEDULE. */
  trigger?: SourceRunTrigger;
}

/**
 * The terminal outcome of a run. Counters are written as a whole so a finalized run
 * is a single consistent snapshot of the funnel.
 *
 * `SUCCEEDED` means "the run completed"; a completed run that unexpectedly found
 * nothing is `SUCCEEDED` **with `unexpectedZeroResults: true`**, not a failure and
 * not silently indistinguishable from a healthy run.
 */
export interface SourceRunOutcome {
  status: SourceRunStatus.SUCCEEDED | SourceRunStatus.FAILED | SourceRunStatus.PARTIAL;
  jobsDiscovered: number;
  jobsAccepted: number;
  jobsDuplicate: number;
  jobsRejected: number;
  parseFailures: number;
  httpFailures: number;
  unexpectedZeroResults: boolean;
  errorSummary?: string | null;
}

/**
 * Raised when a source already has an active run. This is the database-level
 * guarantee behind FR-003 (source isolation) surfacing as a typed conflict, so the
 * API layer can answer 409 SOURCE_RUN_ACTIVE without inspecting SQLSTATE itself.
 */
export class SourceRunActiveError extends Error {
  constructor(readonly sourceId: string) {
    super(`source ${sourceId} already has an active collection run`);
    this.name = 'SourceRunActiveError';
  }
}

/**
 * Persistence port for collection runs.
 *
 * Fencing contract: `finalize` must only apply to a run that is still active. A
 * worker whose run was reaped as stale ("zombie") must not be able to overwrite the
 * recorded outcome, so a zero-row update means "I was reaped" and the caller must
 * stop rather than retry.
 */
export interface SourceRunRepository {
  /**
   * Open a run in the RUNNING state. Throws SourceRunActiveError when the source
   * already has an active run (the `one_active_run_per_source` partial index).
   */
  start(input: StartSourceRunInput): Promise<SourceRunRecord>;

  /**
   * Record the terminal outcome. Returns null when the run is no longer active
   * (already finalized, or reaped as stale) - the fenced finalizer.
   */
  finalize(runId: string, outcome: SourceRunOutcome): Promise<SourceRunRecord | null>;

  /**
   * Fail every run still active after more than `maxDurationSeconds` on the
   * database clock, recording SOURCE_RUN_LEASE_EXPIRED_REASON (ENG-025).
   *
   * Must run before scheduled catch-up enqueues work (SRS 7.6), otherwise the
   * catch-up collides with a run that is already dead.
   */
  reapStaleRuns(maxDurationSeconds: number): Promise<SourceRunRecord[]>;

  findById(runId: string): Promise<SourceRunRecord | null>;
}
