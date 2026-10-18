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

/** The outcome of an exclusive enqueue: the task, and who created it. */
export interface EnqueueWorkTaskResult {
  task: WorkTaskRecord;
  /**
   * True when this call inserted the task. False means an active task already existed for
   * the dedupe key and is being returned — for the manual-run endpoint that is exactly the
   * "a collection is already in progress" signal behind 409 SOURCE_RUN_ACTIVE.
   */
  created: boolean;
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
   * Same as `enqueue`, but reports whether this call created the task. An active task
   * already existing for the dedupe key returns it with `created: false`, which is the
   * only thing that lets a caller tell "I started this" from "this was already running"
   * without a racy read-then-write.
   *
   * The guarantee is the `one_active_task_per_dedupe_key` partial index: exactly one of
   * two concurrent exclusive enqueues on the same key inserts.
   */
  enqueueOrConflict(input: EnqueueWorkTaskInput): Promise<EnqueueWorkTaskResult>;

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
