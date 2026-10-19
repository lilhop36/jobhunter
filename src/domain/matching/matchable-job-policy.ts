import { DescriptionQuality, LifecycleStatus } from '../enums';
import type { MatchableJob } from '../types/matchable-job';

/**
 * Which Jobs are eligible to be scored (SRS 5.2; ADR-0005).
 *
 * Only an ACTIVE Job with a usable description is matchable. UNUSABLE is not a negative
 * fact about the job — it means the text was not collected well enough to score — so such a
 * job is *excluded* rather than scored low (ENG-001: missing evidence is not negative
 * evidence).
 *
 * The reader applies this as a SQL predicate for efficiency; the use case re-applies it to
 * what the reader returned, so a job supplied from anywhere else cannot bypass the policy.
 */
export function isMatchable(lifecycleStatus: LifecycleStatus, job: MatchableJob): boolean {
  return (
    lifecycleStatus === LifecycleStatus.ACTIVE &&
    job.descriptionQuality !== DescriptionQuality.UNUSABLE
  );
}
