import { Prisma, PrismaClient } from '@prisma/client';
import { JobSourceRepository, SchedulableSource, SourceHealthUpdate } from '@ports/job-source-repository';

/** See PrismaSourceRunRepository for why the timestamp columns use the UTC clock. */
const NOW_UTC = Prisma.raw("date_trunc('milliseconds', now() AT TIME ZONE 'UTC')");

interface SchedulableSourceRow {
  id: string;
  name: string;
  schedule: string | null;
  lastAttemptAt: Date | string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Source read model for the scheduler (FR-001/FR-002).
 *
 * The last attempt is the most recent run start, whatever its status — a failing source must
 * still be retried on its interval rather than on every tick. The correlated `max` rides the
 * `(sourceId, startedAt)` index on `source_runs`, so listing enabled sources stays a single
 * statement with no external I/O.
 */
export class PrismaJobSourceRepository implements JobSourceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listSchedulable(): Promise<SchedulableSource[]> {
    const rows = await this.prisma.$queryRaw<SchedulableSourceRow[]>`
      SELECT s."id", s."name", s."schedule",
             (SELECT max(r."startedAt") FROM "source_runs" r WHERE r."sourceId" = s."id") AS "lastAttemptAt"
      FROM "job_sources" s
      WHERE s."enabled" = true
      ORDER BY s."name" ASC
    `;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      schedule: row.schedule,
      lastAttemptAt: row.lastAttemptAt === null ? null : toDate(row.lastAttemptAt),
    }));
  }

  /**
   * Record what the most recent collection said about the source (FR-020).
   *
   * `COALESCE` is the "null means leave it" rule from the port: a failure must not erase
   * `lastSuccessfulRunAt`, and a success must not erase `lastErrorAt`, so the two columns
   * together still answer "when did it last work" and "when did it last break".
   */
  async applyHealthUpdate(sourceId: string, update: SourceHealthUpdate): Promise<void> {
    // The row is guaranteed to exist: `source_runs.sourceId` is a foreign key to it and the
    // caller records health for a run it just finalized.
    await this.prisma.$executeRaw`
      UPDATE "job_sources"
      SET "healthStatus" = ${update.status}::"HealthStatus",
          "lastSuccessfulRunAt" = COALESCE(${update.lastSuccessfulRunAt}, "lastSuccessfulRunAt"),
          "lastErrorAt" = COALESCE(${update.lastErrorAt}, "lastErrorAt"),
          "updatedAt" = ${NOW_UTC}
      WHERE "id" = ${sourceId}::uuid
    `;
  }
}
