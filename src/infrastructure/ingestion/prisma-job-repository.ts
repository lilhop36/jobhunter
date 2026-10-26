import { Prisma, PrismaClient } from '@prisma/client';
import { DescriptionQuality, LifecycleStatus, SourceRunStatus } from '@domain/enums';
import { RECONCILED_LIFECYCLE_STATUSES } from '@domain/lifecycle/lifecycle-policy';
import { DEADLINE_RECONCILED_STATUSES } from '@domain/lifecycle/deadline-policy';
import {
  DeadlineCandidate,
  JobRecord,
  JobRepository,
  LifecycleCandidate,
  LifecycleStatusUpdate,
  UpsertJobInput,
  UpsertJobResult,
} from '@ports/job-repository';

/** See PrismaSourceRunRepository for why the timestamp columns use the UTC clock. */
const NOW_UTC = Prisma.raw("date_trunc('milliseconds', now() AT TIME ZONE 'UTC')");

const JOB_COLUMNS = Prisma.raw(`
  "id", "sourceId", "rawJobId", "identityKey", "canonicalUrl", "title", "company",
  "description", "descriptionQuality"::text AS "descriptionQuality", "locationText",
  "contentFingerprint", "publishedAt", "createdAt", "updatedAt"
`);

/** Fields refreshed whenever a source record is observed again with changed content. */
const JOB_REFRESH_COLUMNS = Prisma.raw(`
  "rawJobId" = EXCLUDED."rawJobId",
  "canonicalUrl" = EXCLUDED."canonicalUrl",
  "title" = EXCLUDED."title",
  "company" = EXCLUDED."company",
  "description" = EXCLUDED."description",
  "descriptionQuality" = EXCLUDED."descriptionQuality",
  "locationText" = EXCLUDED."locationText",
  "locationCategory" = EXCLUDED."locationCategory",
  "remoteStatus" = EXCLUDED."remoteStatus",
  "publishedCalendar" = EXCLUDED."publishedCalendar",
  "originalPublishedDateText" = EXCLUDED."originalPublishedDateText",
  "publishedAt" = EXCLUDED."publishedAt",
  "dateConfidence" = EXCLUDED."dateConfidence",
  "applicationDeadline" = EXCLUDED."applicationDeadline",
  "salaryType" = EXCLUDED."salaryType",
  "salaryMin" = EXCLUDED."salaryMin",
  "salaryMax" = EXCLUDED."salaryMax",
  "salaryCurrency" = EXCLUDED."salaryCurrency",
  "salaryPeriod" = EXCLUDED."salaryPeriod",
  "salaryEvidence" = EXCLUDED."salaryEvidence",
  "salaryConfidence" = EXCLUDED."salaryConfidence",
  "employmentType" = EXCLUDED."employmentType",
  "applicationMethod" = EXCLUDED."applicationMethod",
  "applyUrl" = EXCLUDED."applyUrl",
  "applyEmail" = EXCLUDED."applyEmail",
  "contentFingerprint" = EXCLUDED."contentFingerprint",
  "provenance" = EXCLUDED."provenance"
`);

interface JobRow {
  id: string;
  sourceId: string;
  rawJobId: string | null;
  identityKey: string;
  canonicalUrl: string | null;
  title: string | null;
  company: string | null;
  description: string | null;
  descriptionQuality: string;
  locationText: string | null;
  contentFingerprint: string | null;
  publishedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    sourceId: row.sourceId,
    rawJobId: row.rawJobId,
    identityKey: row.identityKey,
    canonicalUrl: row.canonicalUrl,
    title: row.title,
    company: row.company,
    description: row.description,
    descriptionQuality: row.descriptionQuality as DescriptionQuality,
    locationText: row.locationText,
    contentFingerprint: row.contentFingerprint,
    publishedAt: row.publishedAt === null ? null : toDate(row.publishedAt),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

/** ISO-8601 text is stored as a UTC-naive `timestamp(3)`, matching the collection clock. */
function asTimestamp(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

interface LifecycleCandidateRow {
  jobId: string;
  lifecycleStatus: string;
  publishedAt: Date | string | null;
  lastObservedAt: Date | string | null;
  latestQualifyingRunStartedAt: Date | string | null;
  latestQualifyingCatalogueExhausted: boolean | null;
  latestQualifyingOldestListingPublishedAt: Date | string | null;
}

interface DeadlineCandidateRow {
  jobId: string;
  lifecycleStatus: string;
  applicationDeadline: Date | string | null;
}

/**
 * Canonical Job store (SRS 5.2, ADR-0001).
 *
 * The conflict target is the plain unique index `(sourceId, identityKey)` - no
 * predicate, because the index has none. Changed content refreshes the existing Job and
 * repoints `rawJobId` at the newest capture; the previous capture is left in `raw_jobs`
 * untouched, so this never erases evidence and never treats content equality as identity.
 *
 * Nothing here derives `identityKey`, `contentHash` or `contentFingerprint`: all three
 * are computed by the domain layer and passed in as inputs. Monetary amounts arrive as
 * canonical `DecimalAmount` strings and are cast straight to `numeric(14,2)`, so no
 * float ever touches the value (ENG-006).
 */
export class PrismaJobRepository implements JobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(input: UpsertJobInput): Promise<UpsertJobResult> {
    const { sourceId, job } = input;
    const identityKey = input.identityKey;
    if (typeof identityKey !== 'string' || identityKey.length === 0) {
      // An unresolved identity must never be stored: every identity-less Job would share
      // the empty key and merge into one another, which is the exact silent data loss
      // ADR-0001 exists to prevent. The pipeline counts these as undeduplicable instead.
      throw new RangeError('identityKey must be a non-empty string; undeduplicable records are not promoted to Job');
    }

    const rawJobId = input.rawJobId ?? null;
    const publishedAt = asTimestamp(job.publishedDate.publishedAt);
    const applicationDeadline = asTimestamp(job.applicationDeadline.deadlineAt);
    const salaryMin = job.salary.min;
    const salaryMax = job.salary.max;
    const provenance = JSON.stringify(job.provenance ?? {});
    const { application } = job;

    return this.prisma.$transaction(async (tx) => {
      // Lock the existing row (if any) before deciding, so "is this new?" cannot be
      // answered from a snapshot another writer is about to invalidate. With one active
      // run per source there is a single writer per (sourceId, identityKey).
      const existing = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "jobs"
        WHERE "sourceId" = ${sourceId}::uuid AND "identityKey" = ${identityKey}
        FOR UPDATE
      `;

      const rows = await tx.$queryRaw<JobRow[]>`
        INSERT INTO "jobs" (
          "id", "sourceId", "rawJobId", "identityKey", "canonicalUrl", "title", "company",
          "description", "descriptionQuality", "locationText", "locationCategory",
          "remoteStatus", "publishedCalendar", "originalPublishedDateText", "publishedAt",
          "dateConfidence", "salaryType", "salaryMin", "salaryMax", "salaryCurrency",
          "salaryPeriod", "salaryEvidence", "salaryConfidence", "employmentType",
          "applicationDeadline",
          "applicationMethod", "applyUrl", "applyEmail", "contentFingerprint", "provenance",
          "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid(), ${sourceId}::uuid, ${rawJobId}::uuid, ${identityKey},
          ${job.canonicalUrl}, ${job.title}, ${job.company}, ${job.description},
          ${job.descriptionQuality}::"DescriptionQuality", ${job.locationText},
          ${job.locationCategory}::"LocationCategory", ${job.remoteStatus}::"RemoteStatus",
          ${job.publishedDate.calendar}::"CalendarType", ${job.publishedDate.originalText},
          ${publishedAt}::timestamp(3), ${job.publishedDate.confidence}::numeric(4,3),
          ${job.salary.type}::"SalaryType", ${salaryMin}::numeric(14,2),
          ${salaryMax}::numeric(14,2), ${job.salary.currency},
          ${job.salary.period}::"SalaryPeriod", ${job.salary.evidence},
          ${job.salary.confidence}::numeric(4,3),
          ${job.employmentType}::"EmploymentType",
          ${applicationDeadline}::timestamp(3),
          ${application.method}::"ApplicationMethod", ${application.applyUrl},
          ${application.applyEmail}, ${job.contentFingerprint}, ${provenance}::jsonb,
          ${NOW_UTC}, ${NOW_UTC}
        )
        ON CONFLICT ("sourceId", "identityKey") DO UPDATE SET
          ${JOB_REFRESH_COLUMNS},
          "updatedAt" = ${NOW_UTC}
        RETURNING ${JOB_COLUMNS}
      `;

      return { job: toRecord(rows[0]), isNew: existing.length === 0 };
    });
  }

  async findById(id: string): Promise<JobRecord | null> {
    const rows = await this.prisma.$queryRaw<JobRow[]>`
      SELECT ${JOB_COLUMNS} FROM "jobs" WHERE "id" = ${id}::uuid
    `;
    return rows.length === 1 ? toRecord(rows[0]) : null;
  }

  async countForSource(sourceId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS "n" FROM "jobs" WHERE "sourceId" = ${sourceId}::uuid
    `;
    return rows[0].n;
  }

  /**
   * Read model for one source's lifecycle reconciliation (FR-019, SRS 4.4).
   *
   * The lateral join selects the newest "informative collection" **that can speak for this
   * Job** as `@domain/lifecycle` defines it: a run that finished `SUCCEEDED`, discovered at
   * least one record, and either captured the Job (presence is direct evidence), read the
   * listing to the end (`catalogueExhausted`), or recorded a publication-date floor below the
   * Job's own date. Choosing per Job rather than taking the newest run overall matters: when a
   * source moves to capped runs, a newer capped run cannot speak for an old Job, but an
   * earlier complete read still can. Runs that did none of these never qualify.
   *
   * The policy re-checks the window itself; this filter only narrows what it has to consider.
   * Only the statuses this policy owns are returned, so a Job whose state came from other
   * evidence is never even loaded.
   */
  async listLifecycleCandidates(sourceId: string): Promise<LifecycleCandidate[]> {
    const reconciledStatuses = Prisma.join(RECONCILED_LIFECYCLE_STATUSES);
    const rows = await this.prisma.$queryRaw<LifecycleCandidateRow[]>`
      SELECT j."id" AS "jobId",
             j."lifecycleStatus"::text AS "lifecycleStatus",
             j."publishedAt" AS "publishedAt",
             rj."lastSeenAt" AS "lastObservedAt",
             run."startedAt" AS "latestQualifyingRunStartedAt",
             run."catalogueExhausted" AS "latestQualifyingCatalogueExhausted",
             run."oldestListingPublishedAt" AS "latestQualifyingOldestListingPublishedAt"
        FROM "jobs" j
        LEFT JOIN "raw_jobs" rj ON rj."id" = j."rawJobId"
        LEFT JOIN LATERAL (
          SELECT r."startedAt", r."catalogueExhausted", r."oldestListingPublishedAt"
            FROM "source_runs" r
           WHERE r."sourceId" = j."sourceId"
             AND r."status"::text = ${SourceRunStatus.SUCCEEDED}
             AND r."jobsDiscovered" > 0
             AND (
               r."catalogueExhausted" = true
               -- publishedAt is a naive timestamp holding a UTC value, so it is interpreted as
               -- UTC here rather than left for PostgreSQL to resolve against the session's zone
               -- (ENG-022). The floor itself is stored as timestamptz.
               OR (j."publishedAt" IS NOT NULL
                   AND r."oldestListingPublishedAt" IS NOT NULL
                   AND (j."publishedAt" AT TIME ZONE 'UTC') > r."oldestListingPublishedAt")
               -- A run that captured this Job is relevant even when the Job's date sits
               -- outside its window: presence restores, and needs no coverage claim.
               OR (rj."lastSeenAt" IS NOT NULL AND rj."lastSeenAt" >= r."startedAt")
             )
           ORDER BY r."startedAt" DESC
           LIMIT 1
        ) run ON true
       WHERE j."sourceId" = ${sourceId}::uuid
         AND j."lifecycleStatus"::text IN (${reconciledStatuses})
    `;

    return rows.map((row) => {
      const runStartedAt = toNullableDate(row.latestQualifyingRunStartedAt);
      return {
        jobId: row.jobId,
        currentStatus: row.lifecycleStatus as LifecycleStatus,
        publishedAt: toNullableDate(row.publishedAt),
        lastObservedAt: toNullableDate(row.lastObservedAt),
        latestQualifyingRun:
          runStartedAt === null
            ? null
            : {
                startedAt: runStartedAt,
                // A run with no claim cannot reach the lateral join, so both fields are
                // meaningful here.
                catalogueExhausted: row.latestQualifyingCatalogueExhausted === true,
                oldestListingPublishedAt: toNullableDate(
                  row.latestQualifyingOldestListingPublishedAt,
                ),
              },
      };
    });
  }

  /**
   * Read model for the deadline policy (FR-019). The filter is the policy's own ownership
   * rule, expressed in SQL so a Job whose state came from another signal is never loaded.
   */
  async listDeadlineCandidates(): Promise<DeadlineCandidate[]> {
    const ownedStatuses = Prisma.join(DEADLINE_RECONCILED_STATUSES);
    const rows = await this.prisma.$queryRaw<DeadlineCandidateRow[]>`
      SELECT j."id" AS "jobId",
             j."lifecycleStatus"::text AS "lifecycleStatus",
             j."applicationDeadline" AS "applicationDeadline"
        FROM "jobs" j
       WHERE j."lifecycleStatus"::text IN (${ownedStatuses})
         AND (j."applicationDeadline" IS NOT NULL
              OR j."lifecycleStatus"::text = ${LifecycleStatus.EXPIRED})
       ORDER BY j."id" ASC
    `;

    return rows.map((row) => ({
      jobId: row.jobId,
      currentStatus: row.lifecycleStatus as LifecycleStatus,
      applicationDeadline: toNullableDate(row.applicationDeadline),
    }));
  }

  async applyLifecycleStatuses(updates: readonly LifecycleStatusUpdate[]): Promise<number> {
    if (updates.length === 0) return 0;

    // Grouped by target status so a sweep is at most two statements regardless of how many
    // Jobs move. The client (not hand-written SQL) is used here so `@updatedAt` is
    // maintained and uuid arrays need no cast.
    const byStatus = new Map<LifecycleStatus, string[]>();
    for (const { jobId, status } of updates) {
      const ids = byStatus.get(status);
      if (ids === undefined) byStatus.set(status, [jobId]);
      else ids.push(jobId);
    }

    let applied = 0;
    for (const [status, ids] of byStatus) {
      const { count } = await this.prisma.job.updateMany({
        where: { id: { in: ids } },
        data: { lifecycleStatus: status },
      });
      applied += count;
    }
    return applied;
  }
}
