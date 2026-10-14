import { PrismaClient } from '@prisma/client';
import { JobSourceRepository, SchedulableSource } from '@ports/job-source-repository';

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
}
