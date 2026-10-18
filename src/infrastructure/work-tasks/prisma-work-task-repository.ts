import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  ACTIVE_WORK_TASK_STATUSES,
  WorkTaskBackoff,
  WorkTaskFailure,
  WorkTaskRecord,
} from '@domain/types';
import {
  EnqueueWorkTaskInput,
  EnqueueWorkTaskResult,
  WorkTaskRepository,
} from '@ports/work-task-repository';

/**
 * Partial-index predicate values, spliced from the domain constant so the query
 * layer can never drift from the enum or from the `one_active_task_per_dedupe_key`
 * migration. Values are code-controlled enum members, not external input.
 */
const ACTIVE_STATUS_LIST = Prisma.raw(ACTIVE_WORK_TASK_STATUSES.map((s) => `'${s}'`).join(', '));

/**
 * Database clock expressed as a `timestamp(3)` UTC wall-clock value.
 *
 * `work_tasks` timestamp columns are `timestamp(3)` without a time zone, and
 * Prisma (and node-postgres) treat those as UTC. A bare `now()` is `timestamptz`
 * and would be stored in the connection's session time zone, silently shifting
 * every lease/backoff by the server offset. Using `now() AT TIME ZONE 'UTC'`
 * keeps database time consistent with stored values regardless of session TZ.
 *
 * The value is truncated to milliseconds to match the column precision. Without
 * it, a value written as `runAfter` is rounded up to the next millisecond while a
 * comparison still uses the un-rounded microsecond clock, so a task enqueued and
 * claimed inside one transaction (where `now()` is fixed) would intermittently
 * look not-yet-due. Truncating keeps reads and writes on the same grid.
 */
const NOW_UTC = Prisma.raw("date_trunc('milliseconds', now() AT TIME ZONE 'UTC')");

const DEFAULT_BACKOFF: WorkTaskBackoff = { baseSeconds: 5, factor: 2, maxSeconds: 3600 };

export interface PrismaWorkTaskRepositoryOptions {
  /** Bounds for retryable-failure backoff. Defaults to 5s, x2, capped at 1h. */
  backoff?: WorkTaskBackoff;
}

/**
 * The repository only needs raw-query access, so it accepts either a client or an
 * interactive-transaction client. This keeps `SET LOCAL TIME ZONE` regression
 * tests possible without the production path ever opening a transaction.
 */
export type WorkTaskQueryExecutor = PrismaClient | Prisma.TransactionClient;

interface WorkTaskRow {
  id: string;
  type: string;
  payload: unknown;
  dedupeKey: string | null;
  status: WorkTaskRecord['status'];
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAfter: Date | string;
  lockedAt: Date | string | null;
  lockedBy: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | string | null;
  sourceRunId: string | null;
  lastError: string | null;
  lastErrorAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

function toRecord(row: WorkTaskRow): WorkTaskRecord {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    dedupeKey: row.dedupeKey,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAfter: toDate(row.runAfter),
    lockedAt: toNullableDate(row.lockedAt),
    lockedBy: row.lockedBy,
    leaseToken: row.leaseToken,
    leaseExpiresAt: toNullableDate(row.leaseExpiresAt),
    sourceRunId: row.sourceRunId,
    lastError: row.lastError,
    lastErrorAt: toNullableDate(row.lastErrorAt),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
    startedAt: toNullableDate(row.startedAt),
    finishedAt: toNullableDate(row.finishedAt),
  };
}

function assertPositiveSeconds(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive, finite number of seconds; received ${String(value)}`);
  }
}

function validateBackoff(backoff: WorkTaskBackoff): void {
  if (!Number.isFinite(backoff.baseSeconds) || backoff.baseSeconds < 0) {
    throw new RangeError('backoff.baseSeconds must be a finite number >= 0');
  }
  if (!Number.isFinite(backoff.factor) || backoff.factor < 1) {
    throw new RangeError('backoff.factor must be a finite number >= 1');
  }
  if (!Number.isFinite(backoff.maxSeconds) || backoff.maxSeconds < backoff.baseSeconds) {
    throw new RangeError('backoff.maxSeconds must be finite and >= baseSeconds');
  }
}

/**
 * PostgreSQL work-queue repository.
 *
 * Concurrency model:
 *   - `claim` is a single atomic statement using `FOR UPDATE SKIP LOCKED`, so two
 *     workers never take the same row. Attempts are incremented at claim time,
 *     because a claimed row has genuinely started executing.
 *   - Every claim mints a fresh `leaseToken`. Heartbeat/complete/fail match on
 *     `(id, leaseToken, status=RUNNING)`; a worker whose lease expired and was
 *     reaped/re-claimed therefore cannot mutate the newer attempt.
 *   - All timestamps (`runAfter`, `leaseExpiresAt`, `lastErrorAt`, `finishedAt`)
 *     are produced by the database clock (UTC). No external I/O is performed
 *     inside any method, so no transaction is held open across a network call.
 */
export class PrismaWorkTaskRepository implements WorkTaskRepository {
  private readonly backoff: WorkTaskBackoff;

  constructor(
    private readonly prisma: WorkTaskQueryExecutor,
    options: PrismaWorkTaskRepositoryOptions = {},
  ) {
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    validateBackoff(this.backoff);
  }

  async enqueue(input: EnqueueWorkTaskInput): Promise<WorkTaskRecord> {
    return (await this.enqueueOrConflict(input)).task;
  }

  async enqueueOrConflict(input: EnqueueWorkTaskInput): Promise<EnqueueWorkTaskResult> {
    const dedupeKey = input.dedupeKey ?? null;
    const priority = input.priority ?? 0;
    const maxAttempts = input.maxAttempts ?? 5;
    const payloadJson =
      input.payload === undefined || input.payload === null
        ? null
        : JSON.stringify(input.payload);

    // ON CONFLICT DO NOTHING covers the partial unique index. If a duplicate
    // active task exists, resolve it; a concurrent transition to terminal can
    // invalidate that lookup, so retry the insert in that rare race.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const inserted = await this.prisma.$queryRaw<WorkTaskRow[]>`
        INSERT INTO "work_tasks"
          ("id", "type", "payload", "dedupeKey", "priority", "maxAttempts", "runAfter", "createdAt", "updatedAt")
        VALUES
          (gen_random_uuid(), ${input.type}, ${payloadJson}::jsonb, ${dedupeKey}, ${priority},
           ${maxAttempts}, ${NOW_UTC}, ${NOW_UTC}, ${NOW_UTC})
        ON CONFLICT DO NOTHING
        RETURNING *
      `;
      if (inserted.length === 1) return { task: toRecord(inserted[0]), created: true };

      // A null dedupeKey can never conflict with the partial index; a zero-row
      // insert would mean something else went wrong, so retry rather than guess.
      if (dedupeKey === null) continue;

      const existing = await this.prisma.$queryRaw<WorkTaskRow[]>`
        SELECT * FROM "work_tasks"
        WHERE "dedupeKey" = ${dedupeKey}
          AND "status" IN (${ACTIVE_STATUS_LIST})
        LIMIT 1
      `;
      if (existing.length === 1) return { task: toRecord(existing[0]), created: false };
    }

    throw new Error(`enqueue(${input.type}): could not persist or resolve an active task`);
  }

  async claim(workerId: string, leaseSeconds: number): Promise<WorkTaskRecord | null> {
    assertPositiveSeconds(leaseSeconds, 'leaseSeconds');
    const leaseToken = randomUUID();

    const rows = await this.prisma.$queryRaw<WorkTaskRow[]>`
      UPDATE "work_tasks"
      SET "status" = 'RUNNING',
          "leaseToken" = ${leaseToken},
          "leaseExpiresAt" = ${NOW_UTC} + make_interval(secs => ${leaseSeconds}::double precision),
          "lockedAt" = ${NOW_UTC},
          "lockedBy" = ${workerId},
          "attempts" = "attempts" + 1,
          "startedAt" = COALESCE("startedAt", ${NOW_UTC}),
          "updatedAt" = ${NOW_UTC}
      WHERE "id" = (
        SELECT "id" FROM "work_tasks"
        WHERE "status" = 'PENDING' AND "runAfter" <= ${NOW_UTC}
        ORDER BY "priority" DESC, "runAfter" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `;
    return rows.length === 1 ? toRecord(rows[0]) : null;
  }

  async heartbeat(taskId: string, leaseToken: string, leaseSeconds: number): Promise<boolean> {
    assertPositiveSeconds(leaseSeconds, 'leaseSeconds');
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "work_tasks"
      SET "leaseExpiresAt" = ${NOW_UTC} + make_interval(secs => ${leaseSeconds}::double precision),
          "updatedAt" = ${NOW_UTC}
      WHERE "id" = ${taskId}::uuid
        AND "leaseToken" = ${leaseToken}
        AND "status" = 'RUNNING'
      RETURNING "id"
    `;
    return rows.length === 1;
  }

  async complete(taskId: string, leaseToken: string): Promise<WorkTaskRecord | null> {
    const rows = await this.prisma.$queryRaw<WorkTaskRow[]>`
      UPDATE "work_tasks"
      SET "status" = 'SUCCEEDED',
          "finishedAt" = ${NOW_UTC},
          "leaseExpiresAt" = NULL,
          "updatedAt" = ${NOW_UTC}
      WHERE "id" = ${taskId}::uuid
        AND "leaseToken" = ${leaseToken}
        AND "status" = 'RUNNING'
      RETURNING *
    `;
    return rows.length === 1 ? toRecord(rows[0]) : null;
  }

  async fail(
    taskId: string,
    leaseToken: string,
    failure: WorkTaskFailure,
  ): Promise<WorkTaskRecord | null> {
    const { baseSeconds, factor, maxSeconds } = this.backoff;
    const rows = await this.prisma.$queryRaw<WorkTaskRow[]>`
      UPDATE "work_tasks"
      SET "lastError" = ${failure.message},
          "lastErrorAt" = ${NOW_UTC},
          "status" = CASE
            WHEN ${failure.retryable}::boolean = false THEN 'FAILED'::"WorkTaskStatus"
            WHEN "attempts" >= "maxAttempts" THEN 'DEAD_LETTER'::"WorkTaskStatus"
            ELSE 'PENDING'::"WorkTaskStatus"
          END,
          "runAfter" = CASE
            WHEN ${failure.retryable}::boolean = true AND "attempts" < "maxAttempts"
              THEN ${NOW_UTC} + make_interval(secs => LEAST(
                ${baseSeconds}::double precision
                  * power(${factor}::double precision, GREATEST("attempts" - 1, 0)),
                ${maxSeconds}::double precision
              ))
            ELSE "runAfter"
          END,
          "leaseToken" = CASE
            WHEN ${failure.retryable}::boolean = true AND "attempts" < "maxAttempts" THEN NULL
            ELSE "leaseToken"
          END,
          "leaseExpiresAt" = CASE
            WHEN ${failure.retryable}::boolean = true AND "attempts" < "maxAttempts" THEN NULL
            ELSE "leaseExpiresAt"
          END,
          "finishedAt" = CASE
            WHEN ${failure.retryable}::boolean = false OR "attempts" >= "maxAttempts" THEN ${NOW_UTC}
            ELSE NULL
          END,
          "updatedAt" = ${NOW_UTC}
      WHERE "id" = ${taskId}::uuid
        AND "leaseToken" = ${leaseToken}
        AND "status" = 'RUNNING'
      RETURNING *
    `;
    return rows.length === 1 ? toRecord(rows[0]) : null;
  }

  async reapExpiredLeases(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "work_tasks"
      SET "status" = CASE
            WHEN "attempts" >= "maxAttempts" THEN 'DEAD_LETTER'::"WorkTaskStatus"
            ELSE 'PENDING'::"WorkTaskStatus"
          END,
          "runAfter" = ${NOW_UTC},
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "lockedAt" = NULL,
          "lockedBy" = NULL,
          "lastError" = COALESCE(
            "lastError",
            'lease expired before the attempt completed'
          ),
          "lastErrorAt" = COALESCE("lastErrorAt", ${NOW_UTC}),
          "finishedAt" = CASE
            WHEN "attempts" >= "maxAttempts" THEN ${NOW_UTC}
            ELSE NULL
          END,
          "updatedAt" = ${NOW_UTC}
      WHERE "status" = 'RUNNING' AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" < ${NOW_UTC}
      RETURNING "id"
    `;
    return rows.length;
  }
}
