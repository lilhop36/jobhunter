import { RawJobEvidence } from '@domain/types';

/**
 * Persistence identity for one capture. `contentHash` is passed in because it is a
 * domain computation (`rawContentHash` in @domain/normalizers); a repository must
 * never invent a fingerprint (ADR-0001).
 */
export interface ObserveRawJobInput {
  sourceId: string;
  sourceRunId?: string | null;
  evidence: RawJobEvidence;
  /** Versioned raw-content fingerprint of `evidence`. */
  contentHash: string;
}

export interface RawJobRecord {
  id: string;
  sourceId: string;
  sourceRunId: string | null;
  sourceJobIdentifier: string | null;
  sourceUrl: string | null;
  rawTitle: string | null;
  rawCompany: string | null;
  rawLocation: string | null;
  rawDescription: string | null;
  rawPublishedDateText: string | null;
  rawSalaryText: string | null;
  contentHash: string;
  collectedAt: Date;
  /** Last observed by the collection process - never the source's edit time. */
  lastSeenAt: Date;
  createdAt: Date;
}

export interface ObserveRawJobResult {
  rawJob: RawJobRecord;
  /**
   * false when an identical capture was already stored, in which case no row was
   * added and only `lastSeenAt` advanced.
   */
  isNewObservation: boolean;
}

/**
 * Append-only store of raw source evidence (ENG-002).
 *
 * Two guarantees, enforced by the database rather than by convention:
 *   - capturing identical content again is a no-op apart from `lastSeenAt`, and
 *   - changed content is always a *new* row; a stored capture is never overwritten.
 *
 * A capture is never deleted or mutated by a downstream stage; `lastSeenAt` is
 * observation metadata written by collection, which is the stage that produces the
 * row, not a change to captured evidence.
 */
export interface RawJobRepository {
  observe(input: ObserveRawJobInput): Promise<ObserveRawJobResult>;

  findById(id: string): Promise<RawJobRecord | null>;

  /**
   * Every capture of one source record, oldest first. This is the evidence history:
   * earlier captures stay reachable even though only the newest is linked from Job.
   */
  listForSourceRecord(sourceId: string, sourceJobIdentifier: string): Promise<RawJobRecord[]>;
}
