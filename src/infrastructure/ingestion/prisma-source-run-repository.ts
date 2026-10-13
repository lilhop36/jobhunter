import { Prisma, PrismaClient } from '@prisma/client';
import { SourceRunStatus, SourceRunTrigger } from '@domain/enums';
import {
  ACTIVE_SOURCE_RUN_STATUSES,
  SOURCE_RUN_LEASE_EXPIRED_REASON,
  SourceRunRecord,
} from '@domain/types';
import {
  SourceRunActiveError,
  SourceRunOutcome,
  SourceRunRepository,
  StartSourceRunInput,
} from '@ports/source-run-repository';

/**
 * Database clock as a `timestamp(3)` UTC wall-clock value. See
 * PrismaWorkTaskRepository for why a bare `now()` must not be used: the timestamp
 * columns are without time zone, so a `timestamptz` would be written in the
 * session's zone and silently shift every duration.
 */
const NOW_UTC_SQL = "date_trunc('milliseconds', now() AT TIME ZONE 'UTC')";
const NOW_UTC = Prisma.raw(NOW_UTC_SQL);

/**
 * Partial-index predicate values, spliced from the domain constant so the query
 * layer can never drift from the enum or from the `one_active_run_per_source`
 * migration. Values are code-controlled enum members, not external input.
 */
const ACTIVE_RUN_STATUS_LIST = Prisma.raw(
  ACTIVE_SOURCE_RUN_STATUSES.map((status) => `'${status}'`).join(', '),
);

/** Whole-millisecond duration from `startedAt` to now, never negative. */
const DURATION_MS = Prisma.raw(
  `GREATEST(0, (EXTRACT(EPOCH FROM (${NOW_UTC_SQL} - "startedAt")) * 1000)::int)`,
);

const SOURCE_RUN_COLUMNS = Prisma.raw(`
  "id", "sourceId", "status"::text AS "status", "trigger"::text AS "trigger",
  "startedAt", "finishedAt", "durationMs", "jobsDiscovered", "jobsAccepted",
  "jobsDuplicate", "jobsRejected", "undeduplicable", "fallbackIdentities",
  "parseFailures", "httpFailures",
  "unexpectedZeroResults", "errorSummary"
`);

/** The partial unique index that enforces FR-003 source exclusivity. */
const ACTIVE_RUN_INDEX = 'one_active_run_per_source';
const UNIQUE_VIOLATION = '23505';

interface SourceRunRow {
  id: string;
  sourceId: string;
  status: SourceRunStatus;
  trigger: SourceRunTrigger;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  durationMs: number | null;
  jobsDiscovered: number;
  jobsAccepted: number;
  jobsDuplicate: number;
  jobsRejected: number;
  undeduplicable: number;
  fallbackIdentities: number;
  parseFailures: number;
  httpFailures: number;
  unexpectedZeroResults: boolean;
  errorSummary: string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toRecord(row: SourceRunRow): SourceRunRecord {
  return {
    id: row.id,
    sourceId: row.sourceId,
    status: row.status,
    trigger: row.trigger,
    startedAt: toDate(row.startedAt),
    finishedAt: row.finishedAt === null ? null : toDate(row.finishedAt),
    durationMs: row.durationMs,
    jobsDiscovered: row.jobsDiscovered,
    jobsAccepted: row.jobsAccepted,
    jobsDuplicate: row.jobsDuplicate,
    jobsRejected: row.jobsRejected,
    undeduplicable: row.undeduplicable,
    fallbackIdentities: row.fallbackIdentities,
    parseFailures: row.parseFailures,
    httpFailures: row.httpFailures,
    unexpectedZeroResults: row.unexpectedZeroResults,
    errorSummary: row.errorSummary,
  };
}

/**
 * Prisma surfaces raw-query failures as generic request errors, so the SQLSTATE has
 * to be recovered from `meta` or the message depending on the code path.
 */
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { meta?: { code?: unknown; message?: unknown }; message?: unknown };
  if (candidate.meta?.code === UNIQUE_VIOLATION) return true;
  const text = `${String(candidate.message ?? '')} ${String(candidate.meta?.message ?? '')}`;
  return text.includes(UNIQUE_VIOLATION) || text.includes('duplicate key value violates unique constraint');
}

function assertPositiveSeconds(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive, finite number of seconds; received ${String(value)}`);
  }
}

/**
 * PostgreSQL collection-run repository.
 *
 * All timestamps come from the database clock (UTC); no external I/O happens inside
 * any method, so no transaction is ever held open across network work.
 */
export class PrismaSourceRunRepository implements SourceRunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async start(input: StartSourceRunInput): Promise<SourceRunRecord> {
    const trigger = input.trigger ?? SourceRunTrigger.SCHEDULE;
    try {
      const rows = await this.prisma.$queryRaw<SourceRunRow[]>`
        INSERT INTO "source_runs"
          ("id", "sourceId", "status", "trigger", "startedAt", "createdAt", "updatedAt")
        VALUES
          (gen_random_uuid(), ${input.sourceId}::uuid, 'RUNNING'::"SourceRunStatus",
           ${trigger}::"SourceRunTrigger", ${NOW_UTC}, ${NOW_UTC}, ${NOW_UTC})
        RETURNING ${SOURCE_RUN_COLUMNS}
      `;
      return toRecord(rows[0]);
    } catch (error) {
      // Only the active-run index can conflict on this table, so a unique
      // violation here is unambiguously the source-exclusivity guarantee.
      if (isUniqueViolation(error)) throw new SourceRunActiveError(input.sourceId);
      throw error;
    }
  }

  async finalize(runId: string, outcome: SourceRunOutcome): Promise<SourceRunRecord | null> {
    const rows = await this.prisma.$queryRaw<SourceRunRow[]>`
      UPDATE "source_runs"
      SET "status" = ${outcome.status}::"SourceRunStatus",
          "finishedAt" = ${NOW_UTC},
          "durationMs" = ${DURATION_MS},
          "jobsDiscovered" = ${outcome.jobsDiscovered},
          "jobsAccepted" = ${outcome.jobsAccepted},
          "jobsDuplicate" = ${outcome.jobsDuplicate},
          "jobsRejected" = ${outcome.jobsRejected},
          "undeduplicable" = ${outcome.undeduplicable},
          "fallbackIdentities" = ${outcome.fallbackIdentities},
          "parseFailures" = ${outcome.parseFailures},
          "httpFailures" = ${outcome.httpFailures},
          "unexpectedZeroResults" = ${outcome.unexpectedZeroResults},
          "errorSummary" = ${outcome.errorSummary ?? null},
          "updatedAt" = ${NOW_UTC}
      WHERE "id" = ${runId}::uuid
        AND "status" IN (${ACTIVE_RUN_STATUS_LIST})
      RETURNING ${SOURCE_RUN_COLUMNS}
    `;
    return rows.length === 1 ? toRecord(rows[0]) : null;
  }

  async reapStaleRuns(maxDurationSeconds: number): Promise<SourceRunRecord[]> {
    assertPositiveSeconds(maxDurationSeconds, 'maxDurationSeconds');
    const rows = await this.prisma.$queryRaw<SourceRunRow[]>`
      UPDATE "source_runs"
      SET "status" = 'FAILED'::"SourceRunStatus",
          "finishedAt" = ${NOW_UTC},
          "durationMs" = ${DURATION_MS},
          -- The reason a stale run ended is authoritative: a wedged run may carry a
          -- progress note, and keeping it would hide why the run was reclaimed.
          "errorSummary" = ${SOURCE_RUN_LEASE_EXPIRED_REASON},
          "updatedAt" = ${NOW_UTC}
      WHERE "status" IN (${ACTIVE_RUN_STATUS_LIST})
        AND "startedAt" < ${NOW_UTC} - make_interval(secs => ${maxDurationSeconds}::double precision)
      RETURNING ${SOURCE_RUN_COLUMNS}
    `;
    return rows.map(toRecord);
  }

  async findById(runId: string): Promise<SourceRunRecord | null> {
    const rows = await this.prisma.$queryRaw<SourceRunRow[]>`
      SELECT ${SOURCE_RUN_COLUMNS}
      FROM "source_runs"
      WHERE "id" = ${runId}::uuid
    `;
    return rows.length === 1 ? toRecord(rows[0]) : null;
  }
}
