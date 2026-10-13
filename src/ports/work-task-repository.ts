import { WorkTaskFailure, WorkTaskRecord } from '@domain/types';

export interface EnqueueWorkTaskInput {
  type: string;
  payload?: unknown;
  /**
   * When provided, at most one PENDING/RUNNING task may exist for this key.
   * Enqueueing a duplicate active key returns the existing task instead of
   * creating a second one.
   */
  dedupeKey?: string | null;
  /** Higher priority is claimed first (default 0). */
  priority?: number;
  /** Total attempts allowed before a retryable failure becomes DEAD_LETTER (default 5). */
  maxAttempts?: number;
}

/**
 * Persistence port for the PostgreSQL-backed work queue.
 *
 * All methods use database time and are safe under concurrency: claiming uses
 * `FOR UPDATE SKIP LOCKED`, and every mutation after a claim requires the lease
 * token issued to that claim. Callers must keep external I/O (HTTP, Telegram,
 * scraping) outside of any repository call — each method is a single short
 * statement so no transaction is held across network work.
 */
export interface WorkTaskRepository {
  /** Insert a task, honouring active-only `dedupeKey` uniqueness. */
  enqueue(input: EnqueueWorkTaskInput): Promise<WorkTaskRecord>;

  /**
   * Atomically claim the highest-priority due PENDING task, mark it RUNNING,
   * mint a fresh lease token and increment `attempts`. Returns null when no task
   * is available.
   */
  claim(workerId: string, leaseSeconds: number): Promise<WorkTaskRecord | null>;

  /**
   * Extend the lease for the current owner. Returns false when the token is
   * stale (the lease was reclaimed), in which case the worker must stop.
   */
  heartbeat(taskId: string, leaseToken: string, leaseSeconds: number): Promise<boolean>;

  /** Mark a task SUCCEEDED. Returns null when the lease token is stale. */
  complete(taskId: string, leaseToken: string): Promise<WorkTaskRecord | null>;

  /**
   * Record a failed attempt. Retryable failures under the attempt limit return
   * to PENDING with bounded exponential backoff; otherwise the task becomes
   * DEAD_LETTER (retryable, exhausted) or FAILED (permanent). Returns null when
   * the lease token is stale.
   */
  fail(
    taskId: string,
    leaseToken: string,
    failure: WorkTaskFailure,
  ): Promise<WorkTaskRecord | null>;

  /** Return reaped-lease count. Expired RUNNING tasks go back to PENDING. */
  reapExpiredLeases(): Promise<number>;
}
