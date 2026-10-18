import { HealthStatus, SourceRunStatus, SourceRunTrigger } from '@domain/enums';

/**
 * A source as the scheduler sees it (FR-001/FR-002, SRS 7.6).
 *
 * Only the attributes needed to decide whether a scheduled collection is due are exposed;
 * the adapter configuration stays with the worker that builds the adapter.
 */
export interface SchedulableSource {
  id: string;
  name: string;
  /**
   * Raw `schedule` expression (see @domain/scheduling/schedule-interval). `null` or blank
   * means "not scheduled". Never validated here: parsing is the scheduler's job, so an
   * unparseable value is reported rather than silently swallowed.
   */
  schedule: string | null;
  /**
   * Start of the most recent collection run for this source, whatever its outcome, or null
   * when the source has never run. Due-ness is measured from this — not from
   * `lastSuccessfulRunAt` — so a source whose runs keep failing is retried at most once per
   * interval instead of on every scheduler tick.
   */
  lastAttemptAt: Date | null;
}

/**
 * A source as the read API sees it (SRS 3.4 "Source health"; SRS 5.2 JobSource).
 *
 * The SRS fixes the JobSource attributes but not the endpoint body, so this view is the
 * smallest consistent shape: exactly the SRS attributes plus the latest run. `accessPolicy`
 * is deliberately absent — it records the approved access mechanism, is not needed to
 * report health, and an unauthenticated local API has no reason to republish it.
 */
export interface SourceDetail {
  id: string;
  name: string;
  adapterType: string;
  adapterVersion: string;
  enabled: boolean;
  schedule: string | null;
  healthStatus: HealthStatus;
  lastSuccessfulRunAt: Date | null;
  lastErrorAt: Date | null;
  latestRun: SourceRunSummary | null;
}

/** One line of run history: identity, timing and the discovery funnel (SRS 7.4). */
export interface SourceRunSummary {
  id: string;
  status: SourceRunStatus;
  trigger: SourceRunTrigger;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  jobsDiscovered: number;
  jobsAccepted: number;
  jobsDuplicate: number;
  jobsRejected: number;
  undeduplicable: number;
  fallbackIdentities: number;
  parseFailures: number;
  httpFailures: number;
  unexpectedZeroResults: boolean;
  enrichmentScheduled: boolean;
  errorSummary: string | null;
}

/**
 * Keyset cursor for the source list. Ordered by `name`, which is unique, so the name alone
 * is a total order and no tiebreaker column is needed.
 */
export interface SourceCursor {
  name: string;
}

/** Keyset cursor for run history. Ordered by `(startedAt DESC, id DESC)`; runs can share
 *  a millisecond, so `id` breaks the tie. */
export interface RunHistoryCursor {
  startedAt: Date;
  id: string;
}

export interface ListSourcesOptions {
  includeDisabled?: boolean;
  healthStatus?: HealthStatus;
  cursor?: SourceCursor;
  limit: number;
}

export interface PaginatedSources {
  sources: SourceDetail[];
  nextCursor: SourceCursor | null;
}

export interface ListRunsOptions {
  cursor?: RunHistoryCursor;
  limit: number;
  status?: SourceRunStatus;
  trigger?: SourceRunTrigger;
}

export interface PaginatedRuns {
  runs: SourceRunSummary[];
  nextCursor: RunHistoryCursor | null;
}

export interface JobSourceRepository {
  /**
   * Every enabled source with its last collection attempt. Sources with no schedule are
   * included so the scheduler can distinguish "not scheduled" from "scheduled but broken";
   * filtering them out here would hide a misconfigured source from its own diagnostics.
   */
  listSchedulable(): Promise<SchedulableSource[]>;

  /**
   * Sources with health and their latest run, ordered by `name` and paged by keyset so a
   * page boundary cannot shift under concurrent inserts (offset paging would skip rows).
   */
  listSources(options: ListSourcesOptions): Promise<PaginatedSources>;

  /** A single source with health and its latest run, or null when the id is unknown. */
  findById(id: string): Promise<SourceDetail | null>;

  /**
   * Run history for one source, newest first, with keyset pagination on
   * `(startedAt DESC, id DESC)`.
   */
  listRuns(sourceId: string, options: ListRunsOptions): Promise<PaginatedRuns>;
}
