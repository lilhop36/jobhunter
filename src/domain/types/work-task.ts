import { WorkTaskStatus } from '../enums';

/**
 * A work-queue task as observed by the application layer. Mirrors the
 * `work_tasks` table without leaking persistence concerns.
 */
export interface WorkTaskRecord {
  id: string;
  type: string;
  payload: unknown;
  dedupeKey: string | null;
  status: WorkTaskStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  sourceRunId: string | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/**
 * Statuses for which `dedupeKey` is unique — i.e. the task is either waiting to
 * run or currently running. Must match the predicate of the
 * `one_active_task_per_dedupe_key` partial index.
 */
export const ACTIVE_WORK_TASK_STATUSES: readonly WorkTaskStatus[] = [
  WorkTaskStatus.PENDING,
  WorkTaskStatus.RUNNING,
];

/**
 * Evidence for a failed attempt. `retryable` separates transient failures
 * (network blips, 5xx, rate limits) from permanent ones (validation errors, or a
 * 4xx that will not change on retry).
 */
export interface WorkTaskFailure {
  message: string;
  retryable: boolean;
}

/** Exponential backoff bounds applied to retryable failures. */
export interface WorkTaskBackoff {
  baseSeconds: number;
  factor: number;
  maxSeconds: number;
}
