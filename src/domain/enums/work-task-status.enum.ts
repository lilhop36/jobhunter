/**
 * Lifecycle of a queue task.
 *
 * PENDING and RUNNING are "active" (see ACTIVE_WORK_TASK_STATUSES); the rest are
 * terminal. This must match the WorkTaskStatus enum in prisma/schema.prisma and
 * the partial index predicate in
 * prisma/migrations/20261013070000_work_task_lease_and_active_dedupe.
 */
export enum WorkTaskStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  DEAD_LETTER = 'DEAD_LETTER',
}
