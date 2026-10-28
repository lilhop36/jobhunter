/**
 * Reduced-yield detection (SRS 7.8 "Drift detection", FR-020).
 *
 * The SRS requires an operator-visible warning when a source "suddenly produces zero jobs or
 * sharply reduced extraction yield", and fixes no threshold. Zero is handled separately
 * (`isUnexpectedZeroResult`); this is the rule for "sharply reduced", which is the failure a
 * selector change actually produces: the page still renders a handful of cards, so the run
 * completes and would otherwise be recorded as healthy.
 *
 * ## What is compared
 *
 * The observable that covers both failure shapes is the number of records the run actually
 * parsed (`parsed` in the funnel), compared with the median of the source's recent clean runs:
 *
 *   - a listing that shrank (selector reads fewer cards) lowers it,
 *   - a listing that still renders but no longer parses lowers it,
 *   - the median, not the last value, so one backlog dump or one bad day does not define
 *     "normal" and mask the next collapse.
 *
 * It is deliberately *not* `jobsAccepted`: accepted counts deduplicated creations, so a
 * source whose listing is entirely re-observations would look collapsed while being healthy.
 * Parsing is about extraction, which is what drifts.
 *
 * ## Thresholds (engineering defaults, tunable)
 *
 *   - `YIELD_COLLAPSE_RATIO = 0.5`: "sharply reduced" means below half of the baseline,
 *     strictly. A source at 60% of its usual yield is a data point, not an alarm.
 *   - `YIELD_BASELINE_MINIMUM_PARSED = 5`: below five parsed records, normal day-to-day
 *     variance is the same order as the signal, so no verdict is given.
 *   - `YIELD_BASELINE_RUN_LIMIT = 3`: the baseline is the median of up to three clean runs.
 *
 * ## Missing evidence is not negative evidence
 *
 * No baseline (a new source, or only runs that were capped/partial) yields no verdict at
 * all - not a warning and not a healthy claim. The caller decides what an absent verdict
 * means; health stays exactly as it was, which is the same rule the rest of the pipeline
 * follows for UNKNOWN.
 */
export const YIELD_DRIFT_POLICY_VERSION = 'FR-020_YIELD_DRIFT_V1';

/** How many recent clean runs the baseline is taken from. */
export const YIELD_BASELINE_RUN_LIMIT = 3;

/** Current yield must be strictly below this fraction of the baseline to count as collapse. */
export const YIELD_COLLAPSE_RATIO = 0.5;

/** A baseline smaller than this is too small to distinguish drift from normal variance. */
export const YIELD_BASELINE_MINIMUM_PARSED = 5;

/** One run's yield, reduced to what the rule compares. */
export interface SourceYieldSample {
  /** Listing entries the run read (`jobsDiscovered`). */
  listed: number;
  /** Records that normalized successfully (`parsed`); `listed - parseFailures` for a run. */
  parsed: number;
}

export interface YieldDriftObservation {
  /** The run being judged. */
  current: SourceYieldSample;
  /** Recent clean runs, newest first. Empty means no baseline has been established. */
  baseline: readonly SourceYieldSample[];
}

export interface YieldDriftVerdict {
  /** True only when a baseline existed and the current yield fell strictly below half of it. */
  drifted: boolean;
  /** The sentence recorded as the health reason when `drifted`; null otherwise. */
  reason: string | null;
  /** The median compared against, or null when no comparison was possible. */
  baselineParsed: number | null;
}

/** The verdict for a run that was not compared at all. */
export function noYieldDrift(): YieldDriftVerdict {
  return { drifted: false, reason: null, baselineParsed: null };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Decide whether one completed run's yield collapsed against its recent baseline. */
export function classifyYieldDrift(observation: YieldDriftObservation): YieldDriftVerdict {
  const { current, baseline } = observation;
  if (baseline.length === 0) return noYieldDrift();

  const baselineParsed = median(baseline.map((sample) => sample.parsed));
  if (baselineParsed < YIELD_BASELINE_MINIMUM_PARSED) return noYieldDrift();

  if (current.parsed >= baselineParsed * YIELD_COLLAPSE_RATIO) {
    return { drifted: false, reason: null, baselineParsed };
  }

  return {
    drifted: true,
    reason:
      `extraction yield collapsed: ${current.parsed} of ${current.listed} listed records ` +
      `parsed, against a recent baseline of ${baselineParsed} ` +
      `(median of ${baseline.length} clean run${baseline.length === 1 ? '' : 's'})`,
    baselineParsed,
  };
}
