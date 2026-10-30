import { parseScheduleInterval } from '@domain/scheduling/schedule-interval';

/**
 * Silence detection — the other half of "abnormal source behaviour" (SRS 7.8, FR-020).
 *
 * Yield drift (`source-yield-drift.ts`) can only judge a run that happened. The failure it cannot
 * see is the run that never happens: health is written when a run finalizes, so a source whose
 * collection quietly stops — a scheduler that no longer enqueues it, tasks that dead-letter, an
 * adapter that cannot resolve, a worker that is simply not running — keeps its last known
 * `HEALTHY` forever. The operator reads a green row for a source that has been dead for a week.
 *
 * ## What is compared
 *
 * The age of the last *successful* collection against the interval the source itself declares:
 *
 *   - `lastSuccessfulRunAt`, not `lastAttemptAt`. An attempt that failed is not the source
 *     delivering, and it is already reported as `FAILING` by the run that failed. Silence is about
 *     delivery — nothing arriving — so only a success resets the clock.
 *   - `schedule`'s own interval, not a global constant. "Late" is meaningless without knowing when
 *     the source is due, and a `15m` source and a `1d` source do not go quiet at the same age.
 *
 * ## Threshold (an engineering default, tunable)
 *
 * `SOURCE_SILENCE_INTERVAL_MULTIPLIER = 2`: a source is silent once two whole intervals have
 * passed with no successful collection. One missed interval is normal jitter — a run that overran,
 * a task reclaimed and retried, a worker restarted mid-window — and alarming on it would train the
 * operator to ignore the alarm.
 *
 * ## Missing evidence is not negative evidence
 *
 * Three states produce no verdict at all, and the caller must not read them as "healthy":
 *
 *   - the source has never succeeded (`lastSuccessfulRunAt` null) — there is no age to measure, and
 *     a brand-new source is not late for something it has never done;
 *   - the source has no schedule — nothing is due, so nothing is overdue; it is manually collected;
 *   - the schedule is present but unparseable — the scheduler reports that out loud as its own
 *     error; inventing an interval here would be inventing a fact.
 */
export const SOURCE_SILENCE_POLICY_VERSION = 'FR-020_SOURCE_SILENCE_V1';

/** How many declared intervals may pass without a successful collection before the source is silent. */
export const SOURCE_SILENCE_INTERVAL_MULTIPLIER = 2;

export interface SourceSilenceObservation {
  /** The source's last successful collection, or null when it has never had one. */
  lastSuccessfulRunAt: Date | null;
  /** Raw `JobSource.schedule`; parsed here, because the interval is what defines lateness. */
  schedule: string | null;
  /** The clock the caller is answering for, passed in so the rule stays a pure function. */
  now: Date;
}

export interface SourceSilenceVerdict {
  /** True only when the evidence existed and the age exceeded the bound. */
  silent: boolean;
  /** Whether the evidence was absent, so `silent: false` is not a claim of health. */
  measured: boolean;
  /** The sentence the operator sees when silent; null whenever silent is false. */
  reason: string | null;
  /** How long the source has produced nothing, or null when there is no success to measure. */
  ageMs: number | null;
  /** The declared interval the bound was multiplied from, or null when there was none. */
  intervalMs: number | null;
  /**
   * The instant a last success at or after would make the source not silent — `now` minus the
   * bound. Carried so a caller re-checking the evidence in storage does not re-derive the rule and
   * cannot drift from it: the store compares a timestamp, which is the whole decision.
   */
  silentBefore: Date | null;
}

const NOT_MEASURED: Omit<SourceSilenceVerdict, 'ageMs' | 'intervalMs' | 'silentBefore'> = {
  silent: false,
  measured: false,
  reason: null,
};

function hours(ms: number): string {
  return (ms / 3_600_000).toFixed(1);
}

/** Decide whether a scheduled source has gone quiet — produced nothing for over its bound. */
export function classifySourceSilence(
  observation: SourceSilenceObservation,
): SourceSilenceVerdict {
  const { lastSuccessfulRunAt, schedule, now } = observation;

  if (lastSuccessfulRunAt === null) {
    return { ...NOT_MEASURED, ageMs: null, intervalMs: null, silentBefore: null };
  }

  const intervalMs = parseScheduleInterval(schedule);
  if (intervalMs === null) {
    return { ...NOT_MEASURED, ageMs: null, intervalMs: null, silentBefore: null };
  }

  const ageMs = now.getTime() - lastSuccessfulRunAt.getTime();
  const boundMs = intervalMs * SOURCE_SILENCE_INTERVAL_MULTIPLIER;
  const silentBefore = new Date(now.getTime() - boundMs);

  if (ageMs <= boundMs) {
    return { silent: false, measured: true, reason: null, ageMs, intervalMs, silentBefore };
  }

  return {
    silent: true,
    measured: true,
    reason:
      `no successful collection for ${hours(ageMs)} h — the source declares a ` +
      `${hours(intervalMs)} h schedule and ${SOURCE_SILENCE_INTERVAL_MULTIPLIER} whole intervals ` +
      'have passed without one',
    ageMs,
    intervalMs,
    silentBefore,
  };
}
