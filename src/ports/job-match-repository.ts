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

/**
 * Where a page ended. The list order is score descending, then id ascending, so the tuple
 * carries both keys and the page after it is the strictly smaller one.
 */
export interface MatchCursor {
  score: number;
  id: string;
}

export interface ListMatchesOptions {
  /**
   * Matcher revision to list. Required, and supplied by the caller: the route decides that the
   * default is the running `MATCHER_VERSION`, so the repository never reads a config global.
   */
  matcherVersion: string;
  /** Restrict to one candidate. Omitted lists every candidate's matches (FR-012 makes one the v1 reality). */
  userId?: string;
  limit: number;
  cursor?: MatchCursor | null;
}

export interface ListMatchesPage {
  matches: JobMatchRecord[];
  nextCursor: MatchCursor | null;
}

export interface JobMatchRepository {
  saveIfChanged(input: SaveJobMatchInput): Promise<SaveJobMatchOutcome>;

  /** One page of matches, best score first (SRS 3.4 `GET /api/matches`). */
  listMatches(options: ListMatchesOptions): Promise<ListMatchesPage>;

  /**
   * True when any stored match was produced by a revision other than this one.
   *
   * Stored rows carry the `matcherVersion` that produced them (ENG-013), so this is the
   * condition a deploy that changes `MATCHER_VERSION` needs: the stored scores were computed by
   * different rules and must be recomputed rather than read.
   */
  hasMatchesForOtherMatcherVersion(matcherVersion: string): Promise<boolean>;

  findById(id: string): Promise<JobMatchRecord | null>;

  /** The stored row for one exact input set, or null. */
  findByInput(input: {
    userId: string;
    jobId: string;
    matcherVersion: string;
    inputHash: string;
  }): Promise<JobMatchRecord | null>;
}
