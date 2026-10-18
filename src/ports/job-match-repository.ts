import type { JobMatch } from '@domain/types';

/**
 * A persisted match: the deterministic result plus the identity and revision it was
 * stored under (SRS 5.2 JobMatch; FR-013/FR-014/FR-015).
 */
export interface JobMatchRecord extends JobMatch {
  id: string;
  userId: string;
  jobId: string;
  /** Profile revision scored against; a later profile edit never reinterprets this row. */
  profileVersion: string;
  /** sha256 over the canonical scoring inputs (clock excluded); see `JobMatch.inputHash`. */
  inputHash: string;
  /** When the result was produced (not `createdAt`, which is when the row was written). */
  scoredAt: Date;
  createdAt: Date;
}

export interface SaveJobMatchInput {
  userId: string;
  jobId: string;
  profileVersion: string;
  inputHash: string;
  scoredAt: Date;
  match: JobMatch;
}

/**
 * What a save did:
 *   - `inserted`  — no row existed for these inputs;
 *   - `updated`   — a row existed but the recomputed output differs (e.g. freshness moved);
 *   - `unchanged` — a row existed and the output is identical, so nothing was written.
 * There is at most one row per (user, job, matcherVersion, inputHash), so a rerun is
 * idempotent and a changed input set is preserved as history rather than overwritten.
 */
export type SaveJobMatchOutcome = 'inserted' | 'updated' | 'unchanged';

export interface JobMatchRepository {
  saveIfChanged(input: SaveJobMatchInput): Promise<SaveJobMatchOutcome>;

  findById(id: string): Promise<JobMatchRecord | null>;

  /** The stored row for one exact input set, or null. */
  findByInput(input: {
    userId: string;
    jobId: string;
    matcherVersion: string;
    inputHash: string;
  }): Promise<JobMatchRecord | null>;
}
