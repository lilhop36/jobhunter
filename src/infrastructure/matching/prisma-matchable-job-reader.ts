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
import type { DecimalAmount, MatchableJob, Probability } from '@domain/types';
import type {
  ListMatchableJobsOptions,
  MatchableJobBatch,
  MatchableJobReader,
} from '@ports/matchable-job-reader';

/**
 * Exactly the columns the scoring view needs. Choosing them explicitly (rather than the whole
 * row) keeps `description` and the other heavy, non-scoring text out of memory on a long page.
 */
const MATCHABLE_JOB_SELECT = {
  id: true,
  sourceId: true,
  lifecycleStatus: true,
  title: true,
  descriptionQuality: true,
  locationText: true,
  locationCategory: true,
  remoteStatus: true,
  employmentType: true,
  publishedCalendar: true,
  originalPublishedDateText: true,
  publishedAt: true,
  dateConfidence: true,
  salaryType: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  salaryPeriod: true,
  salaryEvidence: true,
  salaryConfidence: true,
  applicationMethod: true,
  applyUrl: true,
  applyEmail: true,
  provenance: true,
} satisfies Prisma.JobSelect;

type StoredJob = Prisma.JobGetPayload<{ select: typeof MATCHABLE_JOB_SELECT }>;

/**
 * `Decimal(14,2)` -> `DecimalAmount`, through the exact decimal's own string form (ENG-006).
 * `toFixed(2)` restores the storage scale, so the amount never passes through a binary float;
 * `asDecimalAmount` validates it at the boundary.
 */
function toDecimalAmount(
  value: Prisma.Decimal | null,
  jobId: string,
  field: string,
): DecimalAmount | null {
  if (value === null) return null;
  try {
    return asDecimalAmount(value.toFixed(2));
  } catch {
    // Ingestion can only write amounts that passed `asDecimalAmount`, so a value that fails
    // here means the row was corrupted or written outside the domain. Failing loudly beats
    // scoring a job on a number the domain cannot represent.
    throw new RangeError(`job ${jobId} has an unusable ${field}: ${String(value)}`);
  }
}

/** `Decimal(4,3)` -> `Probability`. NULL means no confidence was recorded, i.e. no trust. */
function toProbability(value: Prisma.Decimal | null): Probability {
  return asProbability(value === null ? 0 : Number(value));
}

/**
 * How the stored date was derived (`ETHIOPIAN_CALENDAR_V1` …). It is not a Job column: the
 * ingestion pipeline records it in the per-field provenance map, so it is read from there and
 * treated as untrusted JSON rather than assumed from the calendar.
 */
function conversionMethodOf(provenance: unknown): string | null {
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return null;
  }
  const publishedAt = (provenance as Record<string, unknown>).publishedAt;
  if (publishedAt === null || typeof publishedAt !== 'object' || Array.isArray(publishedAt)) {
    return null;
  }
  const method = (publishedAt as Record<string, unknown>).conversionMethod;
  return typeof method === 'string' ? method : null;
}

function toBatch(row: StoredJob): MatchableJobBatch {
  const job: MatchableJob = {
    title: row.title,
    descriptionQuality: row.descriptionQuality as DescriptionQuality,
    locationText: row.locationText,
    locationCategory: row.locationCategory as LocationCategory,
    remoteStatus: row.remoteStatus as RemoteStatus,
    employmentType: row.employmentType as EmploymentType,
    salary: {
      type: row.salaryType as SalaryType,
      min: toDecimalAmount(row.salaryMin, row.id, 'salaryMin'),
      max: toDecimalAmount(row.salaryMax, row.id, 'salaryMax'),
      currency: row.salaryCurrency,
      // The salary normalizer records UNKNOWN as its sentinel for "not stated" and the column
      // is NOT NULL, so it is passed through unchanged: the stored fact, not a re-interpretation.
      period: row.salaryPeriod as SalaryPeriod,
      evidence: row.salaryEvidence,
      confidence: toProbability(row.salaryConfidence),
    },
    publishedDate: {
      calendar: row.publishedCalendar as CalendarType,
      publishedAt: row.publishedAt,
      originalText: row.originalPublishedDateText,
      confidence: toProbability(row.dateConfidence),
      conversionMethod: conversionMethodOf(row.provenance),
    },
    // No stage derives job-side skills or required experience yet (ADR-0005 §2). Empty and
    // null are the honest UNKNOWN: the matcher says "the posting evidences no skills" and
    // lowers confidence instead of scoring the job as if it listed none.
    skills: [],
    requiredExperience: null,
  };

  return {
    jobId: row.id,
    sourceId: row.sourceId,
    lifecycleStatus: row.lifecycleStatus as LifecycleStatus,
    applicationTarget: {
      method: row.applicationMethod as ApplicationMethod,
      applyUrl: row.applyUrl,
      applyEmail: row.applyEmail,
      // The Job table stores the path, not the text it was read from (the detection evidence
      // lives in `provenance`). Eligibility asks whether a path exists, so NULL here is the
      // honest "the stored job does not carry it", never "there was none".
      evidence: null,
    },
    job,
  };
}

/**
 * Reads the Jobs the matcher can score (SRS 5.2; ADR-0005).
 *
 * The eligibility rule is applied in SQL for efficiency and re-applied by the caller
 * (`isMatchable`), so the query is an optimization, never the only enforcement.
 */
export class PrismaMatchableJobReader implements MatchableJobReader {
  constructor(private readonly prisma: PrismaClient) {}

  async listMatchableJobs(options: ListMatchableJobsOptions): Promise<MatchableJobBatch[]> {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new RangeError('listMatchableJobs requires a limit of at least 1 job');
    }

    const rows = await this.prisma.job.findMany({
      where: {
        lifecycleStatus: LifecycleStatus.ACTIVE,
        descriptionQuality: { not: DescriptionQuality.UNUSABLE },
        ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
        ...(options.afterJobId === undefined || options.afterJobId === null
          ? {}
          : { id: { gt: options.afterJobId } }),
      },
      orderBy: { id: 'asc' },
      take: options.limit,
      select: MATCHABLE_JOB_SELECT,
    });

    return rows.map(toBatch);
  }
}
