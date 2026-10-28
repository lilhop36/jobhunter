import { HealthStatus, SourceRunStatus } from '@domain/enums';
import type { YieldDriftVerdict } from './source-yield-drift';

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
 *   - `SUCCEEDED`            -> `HEALTHY`, and the run becomes `lastSuccessfulRunAt` -
 *     unless its yield collapsed against the source's recent baseline (SRS 7.8 drift
 *     detection, `classifyYieldDrift`), in which case it is `DEGRADED`.
 *   - `PARTIAL`              -> `DEGRADED`. The run completed but did not deliver cleanly:
 *     unreadable records (`parseFailures`), or the SRS 3.5 / AC-018 anomaly of zero results
 *     where results were expected.
 *   - `FAILED`               -> `FAILING`.
 *   - `RUNNING` (or absent)  -> no conclusion. A run in flight has observed nothing yet,
 *     so health is left exactly as it was rather than overwritten with a guess.
 *
 * Only `SUCCEEDED` counts as a success. A partial run must not age `lastSuccessfulRunAt` -
 * the columns exist precisely to tell the two apart. A success whose yield collapsed still
 * counts as a success: the run worked, the source's output shrank, and `lastErrorAt` would
 * claim an error that did not happen. Its `DEGRADED` verdict is what makes the drop visible.
 *
 * ## Whose fault was it
 *
 * The policy speaks only for the *source*, so an outcome that was not the source's doing is
 * not an observation about it and produces no verdict at all (`attributableToSource`):
 *
 *   - A reaped run (worker death) never reaches this rule - it is finalized by the recovery
 *     sweep, which does not consult health (ENG-025).
 *   - A run cut short by the worker's *own* shutdown is `PARTIAL` as far as the run record
 *     goes, but blaming the source for it would flip a healthy source to `DEGRADED` and date
 *     an error on every deploy. That is missing evidence dressed up as negative evidence.
 *
 * `ponytail:` the two timestamps are supplied by the store, not by the caller: the run's own
 * finish time is the only timestamp that can be correct, and the store already knows it. The
 * policy therefore reads no clock and stays a pure function of one run's outcome.
 */
export const SOURCE_HEALTH_POLICY_VERSION = 'FR-020_SOURCE_HEALTH_V2';

export interface SourceHealthObservation {
  /** Terminal status of the run that just finished. */
  runStatus: SourceRunStatus;
  /** SRS 3.5 anomaly signal, carried only to make the `DEGRADED` reason truthful. */
  unexpectedZeroResults: boolean;
  /**
   * Whether this run's outcome is evidence about the *source* at all. False for an outcome
   * the worker caused (its own shutdown), which must leave health exactly as it was.
   */
  attributableToSource: boolean;
  /**
   * Reduced-yield evidence from `classifyYieldDrift` (SRS 7.8). Null or absent means the run
   * made no yield claim - a first run, or one that did not read its listing to the end - and
   * must not be read as "no drift".
   */
  yieldDrift?: YieldDriftVerdict | null;
}

export interface SourceHealthVerdict {
  status: HealthStatus;
  /**
   * True when this run counts as the source's most recent *successful* collection: its finish
   * time is stored as `lastSuccessfulRunAt`. False dates the run as the latest error instead.
   * Passed to the store as a decision already made - the store never infers it from `status`.
   */
  countsAsSuccess: boolean;
  /** Why this status was chosen; recorded on the collection log. */
  reason: string;
}

/** The health change one completed run implies, or null when it implies nothing. */
export function classifySourceHealth(
  observation: SourceHealthObservation,
): SourceHealthVerdict | null {
  const { runStatus, unexpectedZeroResults, attributableToSource } = observation;

  // A shutdown is not the source misbehaving, so it is not an observation about the source.
  if (!attributableToSource) return null;

  switch (runStatus) {
    case SourceRunStatus.SUCCEEDED:
      // A run that completed but extracted far less than the source usually does is the
      // SRS 7.8 drift case: the run is a success, the source is not delivering. Reporting
      // HEALTHY here is what let a selector change decay silently for days.
      if (observation.yieldDrift?.drifted) {
        return {
          status: HealthStatus.DEGRADED,
          countsAsSuccess: true,
          reason:
            observation.yieldDrift.reason ??
            'the most recent collection extracted far less than the source usually does',
        };
      }
      return {
        status: HealthStatus.HEALTHY,
        countsAsSuccess: true,
        reason: 'the most recent collection completed successfully',
      };
    case SourceRunStatus.PARTIAL:
      return {
        status: HealthStatus.DEGRADED,
        countsAsSuccess: false,
        reason: unexpectedZeroResults
          ? 'the most recent collection returned zero results where results were expected'
          : 'the most recent collection completed only partially',
      };
    case SourceRunStatus.FAILED:
      return {
        status: HealthStatus.FAILING,
        countsAsSuccess: false,
        reason: 'the most recent collection failed',
      };
    default:
      // RUNNING: nothing has been observed yet, so health is not re-derived.
      return null;
  }
}
