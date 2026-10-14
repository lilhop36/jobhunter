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

export interface JobSourceRepository {
  /**
   * Every enabled source with its last collection attempt. Sources with no schedule are
   * included so the scheduler can distinguish "not scheduled" from "scheduled but broken";
   * filtering them out here would hide a misconfigured source from its own diagnostics.
   */
  listSchedulable(): Promise<SchedulableSource[]>;
}
