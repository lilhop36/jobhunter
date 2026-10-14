import { HealthStatus, SourceRunStatus } from '@domain/enums';

/**
 * Deterministic source health derived from one completed collection (FR-020, SRS 4.9 /
 * 7.3, AC-018).
 *
 * The SRS requires abnormal source behavior to be detected and gives the states
 * (`HEALTHY | DEGRADED | FAILING | UNKNOWN`, Appendix A) but fixes no rule for choosing
 * one. This is that rule, and it reads only evidence the collection already produced:
 * the terminal status of the most recent run.
 *
 * Health is the *latest observation*, not a score. A source that just failed is `FAILING`
 * even if it succeeded all last week, and the next clean run restores `HEALTHY`. That is
 * deliberately threshold-free - there is no failure count or window to misconfigure, and
 * a flapping source is visible as flapping rather than smoothed into a number.
 *
 *   - `SUCCEEDED`            -> `HEALTHY`, and the run becomes `lastSuccessfulRunAt`.
 *   - `PARTIAL`              -> `DEGRADED`. The run completed but did not deliver cleanly:
 *     a partial acquisition (shutdown), unreadable records (`parseFailures`), or the SRS
 *     3.5 / AC-018 anomaly of zero results where results were expected.
 *   - `FAILED`               -> `FAILING`.
 *   - `RUNNING` (or absent)  -> no conclusion. A run in flight has observed nothing yet,
 *     so health is left exactly as it was rather than overwritten with a guess.
 *
 * Only `SUCCEEDED` moves `lastSuccessfulRunAt`. A partial run is not a success, so it must
 * not age the last known-good collection - the columns exist precisely to tell the two
 * apart.
 *
 * `ponytail:` a reaped run (a worker death) is recorded `FAILED` by the recovery sweep but
 * does not pass through here, because lease expiry is evidence about the worker lease, not
 * about the source. Every genuine source fault still reaches this rule through the normal
 * failure or acquisition-timeout path, which is what `FAILING` is for.
 */
export const SOURCE_HEALTH_POLICY_VERSION = 'FR-020_SOURCE_HEALTH_V1';

export interface SourceHealthObservation {
  /** Terminal status of the run that just finished. */
  runStatus: SourceRunStatus;
  /** When that run finished, per the database clock. Null leaves both timestamps alone. */
  finishedAt: Date | null;
  /** SRS 3.5 anomaly signal, carried only to make the `DEGRADED` reason truthful. */
  unexpectedZeroResults: boolean;
}

export interface SourceHealthUpdate {
  status: HealthStatus;
  /** New `lastSuccessfulRunAt`, or null to leave the recorded success untouched. */
  lastSuccessfulRunAt: Date | null;
  /** New `lastErrorAt`, or null to leave the recorded error untouched. */
  lastErrorAt: Date | null;
  /** Why this status was chosen; recorded on the collection log. */
  reason: string;
}

/** The health update one completed run implies, or null when it implies nothing. */
export function classifySourceHealth(
  observation: SourceHealthObservation,
): SourceHealthUpdate | null {
  const { runStatus, finishedAt, unexpectedZeroResults } = observation;

  switch (runStatus) {
    case SourceRunStatus.SUCCEEDED:
      return {
        status: HealthStatus.HEALTHY,
        lastSuccessfulRunAt: finishedAt,
        lastErrorAt: null,
        reason: 'the most recent collection completed successfully',
      };
    case SourceRunStatus.PARTIAL:
      return {
        status: HealthStatus.DEGRADED,
        lastSuccessfulRunAt: null,
        lastErrorAt: finishedAt,
        reason: unexpectedZeroResults
          ? 'the most recent collection returned zero results where results were expected'
          : 'the most recent collection completed only partially',
      };
    case SourceRunStatus.FAILED:
      return {
        status: HealthStatus.FAILING,
        lastSuccessfulRunAt: null,
        lastErrorAt: finishedAt,
        reason: 'the most recent collection failed',
      };
    default:
      // RUNNING: nothing has been observed yet, so health is not re-derived.
      return null;
  }
}
