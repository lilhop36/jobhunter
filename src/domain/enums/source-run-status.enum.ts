/**
 * Lifecycle of one collection run for one source.
 *
 * Engineering-owned state machine: the SRS defines no SourceRun statuses. This must
 * match the SourceRunStatus enum in prisma/schema.prisma and the predicate of the
 * `one_active_run_per_source` partial index, which treats RUNNING as the active
 * state (see ACTIVE_SOURCE_RUN_STATUSES).
 */
export enum SourceRunStatus {
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  PARTIAL = 'PARTIAL',
}
