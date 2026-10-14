import { HealthStatus } from '@domain/enums';

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
 * A health change implied by one completed collection (FR-020). Produced by
 * `@domain/health` and passed in already decided: this port stores the outcome, it never
 * derives health from a run status itself (the derivation is a domain rule, ADR-0001).
 *
 * The two timestamps are "set to this", not "set to this or clear": null means leave the
 * column as it was, so a failing run cannot erase when the source last worked.
 */
export interface SourceHealthUpdate {
  status: HealthStatus;
  lastSuccessfulRunAt: Date | null;
  lastErrorAt: Date | null;
}

export interface JobSourceRepository {
  /**
   * Every enabled source with its last collection attempt. Sources with no schedule are
   * included so the scheduler can distinguish "not scheduled" from "scheduled but broken";
   * filtering them out here would hide a misconfigured source from its own diagnostics.
   */
  listSchedulable(): Promise<SchedulableSource[]>;

  /**
   * Record the health one finished collection implies (FR-020). Called only for a run
   * that actually reached a terminal status: a run whose outcome was discarded (reaped as
   * stale) is not evidence about the source and must not move its health.
   */
  applyHealthUpdate(sourceId: string, update: SourceHealthUpdate): Promise<void>;
}
