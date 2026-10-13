import { DescriptionQuality } from '@domain/enums';
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
}
