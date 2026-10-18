import { JobSource, PrismaClient, SourceRun } from '@prisma/client';
import { HealthStatus, SourceRunStatus, SourceRunTrigger } from '@domain/enums';
import {
  JobSourceRepository,
  ListRunsOptions,
  ListSourcesOptions,
  PaginatedRuns,
  PaginatedSources,
  SchedulableSource,
  SourceDetail,
  SourceRunSummary,
} from '@ports/job-source-repository';

/** The one run a source row is joined to: its most recent, by the run-history order. */
const LATEST_RUN_ORDER = [{ startedAt: 'desc' }, { id: 'desc' }] as const;

type JobSourceWithLatestRun = JobSource & { runs: SourceRun[] };

/**
 * Prisma models its enums as string-literal unions, the domain as TypeScript enums. The
 * values are identical (they are the same database types), but the two are not structurally
 * assignable, so each is converted at this boundary — the one place allowed to know both.
 */
function toRunSummary(run: SourceRun): SourceRunSummary {
  return {
    id: run.id,
    status: run.status as SourceRunStatus,
    trigger: run.trigger as SourceRunTrigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    jobsDiscovered: run.jobsDiscovered,
    jobsAccepted: run.jobsAccepted,
    jobsDuplicate: run.jobsDuplicate,
    jobsRejected: run.jobsRejected,
    undeduplicable: run.undeduplicable,
    fallbackIdentities: run.fallbackIdentities,
    parseFailures: run.parseFailures,
    httpFailures: run.httpFailures,
    unexpectedZeroResults: run.unexpectedZeroResults,
    enrichmentScheduled: run.enrichmentScheduled,
    errorSummary: run.errorSummary,
  };
}

function toSourceDetail(row: JobSourceWithLatestRun): SourceDetail {
  const latest = row.runs[0];
  return {
    id: row.id,
    name: row.name,
    adapterType: row.adapterType,
    adapterVersion: row.adapterVersion,
    enabled: row.enabled,
    schedule: row.schedule,
    healthStatus: row.healthStatus as HealthStatus,
    lastSuccessfulRunAt: row.lastSuccessfulRunAt,
    lastErrorAt: row.lastErrorAt,
    latestRun: latest ? toRunSummary(latest) : null,
  };
}

export class PrismaJobSourceRepository implements JobSourceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Every enabled source with its last collection attempt. Sources with no schedule are
   * included so the scheduler can distinguish "not scheduled" from "scheduled but broken";
   * filtering them out here would hide a misconfigured source from its own diagnostics.
   */
  async listSchedulable(): Promise<SchedulableSource[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        name: string;
        schedule: string | null;
        lastAttemptAt: Date | string | null;
      }[]
    >`
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
      lastAttemptAt: row.lastAttemptAt === null ? null : new Date(row.lastAttemptAt),
    }));
  }

  async listSources(options: ListSourcesOptions): Promise<PaginatedSources> {
    const { includeDisabled = false, healthStatus, cursor, limit } = options;

    const rows = await this.prisma.jobSource.findMany({
      where: {
        ...(includeDisabled ? {} : { enabled: true }),
        ...(healthStatus ? { healthStatus } : {}),
        // Keyset, not offset: `name` is unique, so `name > cursor` is a total order and a
        // concurrently inserted source cannot shift a later page.
        ...(cursor ? { name: { gt: cursor.name } } : {}),
      },
      orderBy: { name: 'asc' },
      take: limit + 1,
      include: { runs: { orderBy: [...LATEST_RUN_ORDER], take: 1 } },
    });

    const page = rows.slice(0, limit);
    return {
      sources: page.map(toSourceDetail),
      nextCursor: rows.length > limit ? { name: page[page.length - 1].name } : null,
    };
  }

  async findById(id: string): Promise<SourceDetail | null> {
    const row = await this.prisma.jobSource.findUnique({
      where: { id },
      include: { runs: { orderBy: [...LATEST_RUN_ORDER], take: 1 } },
    });
    return row === null ? null : toSourceDetail(row);
  }

  async listRuns(sourceId: string, options: ListRunsOptions): Promise<PaginatedRuns> {
    const { cursor, limit, status, trigger } = options;

    const rows = await this.prisma.sourceRun.findMany({
      where: {
        sourceId,
        ...(status ? { status } : {}),
        ...(trigger ? { trigger } : {}),
        // Runs share a millisecond, so the cursor is the (startedAt, id) pair and the
        // comparison is the lexicographic `(startedAt, id) < (cursor.startedAt, cursor.id)`.
        ...(cursor
          ? {
              OR: [
                { startedAt: { lt: cursor.startedAt } },
                { startedAt: cursor.startedAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [...LATEST_RUN_ORDER],
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      runs: page.map(toRunSummary),
      nextCursor: rows.length > limit ? { startedAt: last.startedAt, id: last.id } : null,
    };
  }
}
