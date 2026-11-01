import { DescriptionQuality, LifecycleStatus } from '@domain/enums';
import type { LifecycleRunEvidence } from '@domain/lifecycle/lifecycle-policy';
import { NormalizedJob } from '@domain/types';

/**
 * A canonical Job plus the persistence identity it is stored under.
 *
 * `identityKey` is the source-scoped source-record identity (ADR-0001), computed by the
 * domain layer from the *raw record* (`sourceRecordIdentityKey` in
 * @domain/normalizers) - deliberately not from `job.contentFingerprint`, because
 * content equality is not identity. It is NOT NULL: a Job exists only for a record
 * whose identity resolved, so undeduplicable evidence is counted but never promoted.
 */
export interface UpsertJobInput {
  sourceId: string;
  /** The capture this state came from; repointed on every refresh. */
  rawJobId?: string | null;
  identityKey: string;
  job: NormalizedJob;
}

export interface JobRecord {
  id: string;
  sourceId: string;
  rawJobId: string | null;
  identityKey: string;
  canonicalUrl: string | null;
  title: string | null;
  company: string | null;
  description: string | null;
  descriptionQuality: DescriptionQuality;
  locationText: string | null;
  contentFingerprint: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertJobResult {
  job: JobRecord;
  /** true when this call created the Job; false when it refreshed an existing one. */
  isNew: boolean;
}

/**
 * Everything the lifecycle policy needs about one Job (FR-019). Gathered by the store
 * because the evidence spans `jobs`, `raw_jobs` and `source_runs`; the rule itself stays in
 * `@domain/lifecycle`.
 */
export interface LifecycleCandidate {
  jobId: string;
  currentStatus: LifecycleStatus;
  /** `lastSeenAt` of the Job's newest capture, or null when that capture is gone. */
  lastObservedAt: Date | null;
  /**
   * The Job's stored publication date, used to place it inside a run's coverage window.
   * Null when the source evidence yielded no date.
   */
  publishedAt: Date | null;
  /**
   * The source's most recent informative run whose coverage includes this Job - it read the
   * whole listing, or its publication-date floor is below the Job's date - or null when no
   * run could have seen it. A newer capped run that does not reach this Job is skipped in
   * favour of an older complete read: it cannot speak for the Job, but it does not erase what
   * an earlier run covered.
   */
  latestQualifyingRun: LifecycleRunEvidence | null;
}

/**
 * One lifecycle move, as a compare-and-set (audit M1).
 *
 * `expectedStatus` is the state the policy read when it decided. Applying only while the row
 * still holds it means the two policies that write this column - presence and deadline - cannot
 * clobber each other's determination when they interleave, and neither can overwrite a newer
 * observation made after its own read. A move whose expectation no longer holds is not applied
 * and is not retried: the other writer's state is the fresher evidence, and the next pass reads
 * it before deciding again.
 */
export interface LifecycleStatusUpdate {
  jobId: string;
  /** The status this Job holds now, per the caller's read. The write is fenced on it. */
  expectedStatus: LifecycleStatus;
  /** The status the policy decided the evidence supports. */
  status: LifecycleStatus;
}

/**
 * Everything the deadline policy needs about one Job (FR-019). Read separately from
 * {@link LifecycleCandidate} because the two policies own different states and must not
 * accidentally receive each other's evidence.
 */
export interface DeadlineCandidate {
  jobId: string;
  currentStatus: LifecycleStatus;
  /** The stored deadline, or null when the source stated none this system could read. */
  applicationDeadline: Date | null;
}

/**
 * Store for the canonical, evidence-derived Job (SRS 5.2).
 *
 * Uniqueness is `(sourceId, identityKey)` only. There is no cross-source identity and
 * no merging: two sources producing the same key are two Jobs (ENG-005 deferred).
 * `contentFingerprint` is stored as a duplicate signal and is deliberately not unique.
 */
export interface JobRepository {
  upsert(input: UpsertJobInput): Promise<UpsertJobResult>;

  findById(id: string): Promise<JobRecord | null>;

  countForSource(sourceId: string): Promise<number>;

  /**
   * Jobs of one source that the lifecycle policy owns (see
   * `RECONCILED_LIFECYCLE_STATUSES`), with the observation evidence to reconcile them.
   */
  listLifecycleCandidates(sourceId: string): Promise<LifecycleCandidate[]>;

  /**
   * Jobs the deadline policy owns (see `DEADLINE_RECONCILED_STATUSES`), with the stored
   * deadline. Table-wide rather than per-source: a stated deadline is a fact about the posting,
   * so expiry does not depend on which source is being collected or when it last ran.
   *
   * ACTIVE jobs with no deadline are not returned — the policy can say nothing about them, and
   * they are the overwhelming majority.
   */
  listDeadlineCandidates(): Promise<DeadlineCandidate[]>;

  /**
   * Apply decided lifecycle statuses, each fenced on the status the caller read. Returns how
   * many Jobs were actually written, so a caller that decided from a stale read sees its move
   * silently not applied rather than overwriting what it never saw (audit M1).
   */
  applyLifecycleStatuses(updates: readonly LifecycleStatusUpdate[]): Promise<number>;
}
