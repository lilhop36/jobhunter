import type { LifecycleStatus } from '@domain/enums';
import type { ApplicationTarget, MatchableJob } from '@domain/types';

/**
 * One storable job, as the matcher sees it (SRS 5.2; FR-012, FR-013).
 *
 * This is a dedicated read model, not a widening of the shared `JobRecord` port: `JobRecord`
 * deliberately omits locationCategory / remoteStatus / employmentType / salary / publishedDate,
 * and adding them there would make every ingestion caller carry matching fields it never uses.
 *
 * The batch carries the two things the scoring view cannot: the job id, to key the stored
 * match, and the lifecycle status, so the caller can re-apply the matchable-job policy
 * (`isMatchable`) without a second query.
 */
export interface MatchableJobBatch {
  jobId: string;
  sourceId: string;
  /** Returned so the caller can re-check the policy; not re-derived from `job`. */
  lifecycleStatus: LifecycleStatus;
  /**
   * The job's application path, returned for the same reason as `lifecycleStatus`: SRS 3.2's
   * "usable application target" is a notification policy the caller re-applies, and the read
   * that scores a job should be the only read it needs.
   */
  applicationTarget: ApplicationTarget;
  job: MatchableJob;
}

export interface ListMatchableJobsOptions {
  /** Restrict to one source (the matching trigger runs per source run). */
  sourceId?: string;
  /** Keyset cursor: the last job id of the previous page. Omit for the first page. */
  afterJobId?: string | null;
  /** Page size, at least 1. */
  limit: number;
}

export interface MatchableJobReader {
  /**
   * ACTIVE jobs with a usable description, ordered by job id, one page at a time.
   *
   * The ordering key is the primary key, so a page boundary is a *value* rather than an
   * offset: a concurrent insert cannot make the caller skip or repeat a job.
   *
   * Job-side skills and required experience come back empty/null until an extraction stage
   * produces them (ADR-0005 §2); that is UNKNOWN, not a claim that the posting lists none.
   */
  listMatchableJobs(options: ListMatchableJobsOptions): Promise<MatchableJobBatch[]>;
}
