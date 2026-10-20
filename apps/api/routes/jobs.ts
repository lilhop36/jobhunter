import type { FastifyInstance } from 'fastify';
import type { LifecycleStatus } from '@domain/enums';
import type { JobCursor, JobDetail, JobReader, JobSummary } from '@ports/job-reader';
import { ApiError } from '../errors';
import { decodeCursor, encodeCursor } from '../cursor';
import { UUID_PATTERN, jobIdParams, listJobsQuery } from '../schemas';

/**
 * The two job routes (SRS 3.4 `GET /api/jobs` and `GET /api/jobs/:id`; FR-011, SRS 5.4).
 *
 * The SRS fixes the endpoints but no response body, so the fields below are SRS 5.2's Job
 * attributes under their own names — a client can trace every published value to the attribute it
 * was stored as, and UNKNOWN stays UNKNOWN rather than becoming null or a default.
 *
 * The list carries no description and no provenance: SRS 3.1 asks a low-bandwidth client not to
 * fetch what it will not render, and both are detail-sized. The detail carries the provenance map
 * exactly as stored, because SRS 5.4/ENG-003 require a value's origin and evidence to stay
 * distinguishable from the value itself.
 *
 * Only the running API binds (loopback by default, `API_HOST` in `./config`), so these routes
 * publish stored job data to the local machine until authentication is specified.
 */
export interface JobRoutesDeps {
  jobs: JobReader;
}

const DEFAULT_LIMIT = 20;

export async function registerJobRoutes(app: FastifyInstance, deps: JobRoutesDeps): Promise<void> {
  app.get('/api/jobs', { schema: { querystring: listJobsQuery } }, async (request) => {
    const query = request.query as {
      sourceId?: string;
      lifecycleStatus?: LifecycleStatus;
      cursor?: string;
      limit?: number;
    };

    const page = await deps.jobs.listJobs({
      ...(query.sourceId === undefined ? {} : { sourceId: query.sourceId }),
      ...(query.lifecycleStatus === undefined ? {} : { lifecycleStatus: query.lifecycleStatus }),
      ...(query.cursor === undefined ? {} : { cursor: decodeJobCursor(query.cursor) }),
      limit: query.limit ?? DEFAULT_LIMIT,
    });

    return {
      jobs: page.jobs.map(serializeJob),
      pagination: {
        nextCursor:
          page.nextCursor === null
            ? null
            : encodeCursor({
                createdAt: page.nextCursor.createdAt.toISOString(),
                id: page.nextCursor.id,
              }),
      },
    };
  });

  app.get('/api/jobs/:id', { schema: { params: jobIdParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const job = await deps.jobs.findJob(id);
    if (job === null) throw ApiError.notFound(`Job ${id} was not found`);
    return serializeJobDetail(job);
  });
}

/** SRS 5.2 attribute names, flat; money already an exact decimal string (ENG-006). */
function serializeJob(job: JobSummary) {
  return {
    id: job.id,
    sourceId: job.sourceId,
    sourceName: job.sourceName,
    canonicalUrl: job.canonicalUrl,
    title: job.title,
    company: job.company,
    descriptionQuality: job.descriptionQuality,
    locationText: job.locationText,
    locationCategory: job.locationCategory,
    remoteStatus: job.remoteStatus,
    employmentType: job.employmentType,
    salaryType: job.salaryType,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    salaryPeriod: job.salaryPeriod,
    publishedAt: job.publishedAt === null ? null : job.publishedAt.toISOString(),
    lifecycleStatus: job.lifecycleStatus,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function serializeJobDetail(job: JobDetail) {
  return {
    ...serializeJob(job),
    description: job.description,
    publishedCalendar: job.publishedCalendar,
    originalPublishedDateText: job.originalPublishedDateText,
    dateConfidence: job.dateConfidence,
    salaryConfidence: job.salaryConfidence,
    salaryEvidence: job.salaryEvidence,
    applicationMethod: job.application.method,
    applyUrl: job.application.applyUrl,
    applyEmail: job.application.applyEmail,
    provenance: job.provenance,
  };
}

/**
 * A job cursor is `{ createdAt, id }`. Both parts are validated: the parser would otherwise hand
 * Prisma an unparseable date or a non-UUID id, and the client's mistake would surface as a 500.
 */
function decodeJobCursor(raw: string): JobCursor {
  const value = decodeCursor(raw);
  const createdAt = typeof value?.createdAt === 'string' ? new Date(value.createdAt) : null;
  if (
    value === null ||
    createdAt === null ||
    Number.isNaN(createdAt.getTime()) ||
    typeof value.id !== 'string' ||
    !new RegExp(UUID_PATTERN).test(value.id)
  ) {
    throw ApiError.validation('The pagination cursor is not valid');
  }
  return { createdAt, id: value.id };
}
