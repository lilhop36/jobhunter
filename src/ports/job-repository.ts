import { DescriptionQuality, LifecycleStatus } from '@domain/enums';
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
  /** Start of the source's most recent informative run, or null when it has none. */
  latestQualifyingRunStartedAt: Date | null;
}

export interface LifecycleStatusUpdate {
  jobId: string;
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
   * Apply decided lifecycle statuses. Returns how many Jobs were actually written; callers
   * pass only real changes, so a non-zero result means that many rows moved.
   */
  applyLifecycleStatuses(updates: readonly LifecycleStatusUpdate[]): Promise<number>;
}
