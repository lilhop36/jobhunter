import { Prisma, PrismaClient } from '@prisma/client';
import {
  ApplicationMethod,
  CalendarType,
  DescriptionQuality,
  EmploymentType,
  LifecycleStatus,
  LocationCategory,
  RemoteStatus,
  SalaryPeriod,
  SalaryType,
} from '@domain/enums';
import { asDecimalAmount, asProbability } from '@domain/types';
import type {
  JobCursor,
  JobDetail,
  JobReader,
  JobSummary,
  ListJobsOptions,
  ListJobsPage,
} from '@ports/job-reader';

/**
 * Every read of a job joins the source, because the source's name is part of what a client
 * renders ("Company X via Source Y") and a second round trip per row would be the client's
 * problem instead of ours. One relation, one index lookup.
 */
const JOB_READ_INCLUDE = { source: { select: { name: true } } } as const;

type JobReadRow = Prisma.JobGetPayload<{ include: typeof JOB_READ_INCLUDE }>;

/**
 * Prisma-backed job reads (SRS 3.4 `GET /api/jobs`, `GET /api/jobs/:id`).
 *
 * Two deliberate properties:
 *
 *   - **Exact money.** `salaryMin`/`salaryMax` are `DECIMAL(14,2)`; they leave this boundary as
 *     decimal strings, never as `number`, so a client cannot inherit a binary rounding of a
 *     currency (ENG-006).
 *   - **No filtering the caller did not ask for.** No status is excluded by default and no row is
 *     hidden: `lifecycleStatus` is published, and choosing which states to show is the caller's
 *     decision rather than a read path's opinion.
 *
 * Pagination is `(createdAt, id)` DESC. The tuple is unique because `id` is, which is what makes
 * the keyset exact: two rows written in the same millisecond still page deterministically.
 */
export class PrismaJobReader implements JobReader {
  constructor(private readonly prisma: PrismaClient) {}

  async listJobs(options: ListJobsOptions): Promise<ListJobsPage> {
    const rows = await this.prisma.job.findMany({
      where: {
        ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
        ...(options.lifecycleStatus === undefined
          ? {}
          : { lifecycleStatus: options.lifecycleStatus }),
        ...(options.cursor === undefined || options.cursor === null
          ? {}
          : { OR: cursorConditions(options.cursor) }),
      },
      include: JOB_READ_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One extra row tells us whether a next page exists without a second count query.
      take: options.limit + 1,
    });

    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      jobs: page.map(toSummary),
      nextCursor:
        rows.length > options.limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }

  async findJob(id: string): Promise<JobDetail | null> {
    const row = await this.prisma.job.findUnique({ where: { id }, include: JOB_READ_INCLUDE });
    return row === null ? null : toDetail(row);
  }

  async findJobsByIds(ids: readonly string[]): Promise<Map<string, JobSummary>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.job.findMany({
      where: { id: { in: [...ids] } },
      include: JOB_READ_INCLUDE,
    });
    return new Map(rows.map((row) => [row.id, toSummary(row)]));
  }
}

/**
 * The rows strictly after `cursor` in `(createdAt DESC, id DESC)` order: an older discovery time,
 * or the same instant with a smaller id. Written as an OR rather than a row comparison because
 * Prisma can express it and PostgreSQL can use the same index either way.
 */
function cursorConditions(cursor: JobCursor): Prisma.JobWhereInput[] {
  return [
    { createdAt: { lt: cursor.createdAt } },
    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
  ];
}

function toSummary(row: JobReadRow): JobSummary {
  return {
    id: row.id,
    sourceId: row.sourceId,
    sourceName: row.source.name,
    canonicalUrl: row.canonicalUrl,
    title: row.title,
    company: row.company,
    descriptionQuality: row.descriptionQuality as DescriptionQuality,
    locationText: row.locationText,
    locationCategory: row.locationCategory as LocationCategory,
    remoteStatus: row.remoteStatus as RemoteStatus,
    employmentType: row.employmentType as EmploymentType,
    salaryType: row.salaryType as SalaryType,
    salaryMin: toAmount(row.salaryMin),
    salaryMax: toAmount(row.salaryMax),
    salaryCurrency: row.salaryCurrency,
    salaryPeriod: row.salaryPeriod as SalaryPeriod,
    publishedAt: row.publishedAt,
    lifecycleStatus: row.lifecycleStatus as LifecycleStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDetail(row: JobReadRow): JobDetail {
  return {
    ...toSummary(row),
    description: row.description,
    publishedCalendar: row.publishedCalendar as CalendarType,
    originalPublishedDateText: row.originalPublishedDateText,
    dateConfidence: toConfidence(row.dateConfidence),
    salaryConfidence: toConfidence(row.salaryConfidence),
    salaryEvidence: row.salaryEvidence,
    application: {
      method: row.applicationMethod as ApplicationMethod,
      applyUrl: row.applyUrl,
      applyEmail: row.applyEmail,
    },
    // Published as stored: see `JobDetail.provenance` for why a reader does not reinterpret it.
    provenance: row.provenance,
  };
}

/** A `DECIMAL(14,2)` as the domain's canonical amount string, or null when not disclosed. */
function toAmount(value: Prisma.Decimal | null) {
  return value === null ? null : asDecimalAmount(value.toFixed(2));
}

function toConfidence(value: Prisma.Decimal | null) {
  return value === null ? null : asProbability(Number(value));
}
