import { createHash } from 'node:crypto';
import type { MatchableJob } from '@domain/types';
import { canonicalEncode } from './profile-version';

/**
 * Encoding revision of the hash input. A change to *how* the inputs are encoded (not to what
 * they are) bumps this, so rows written under the old encoding cannot be mistaken for rows
 * written under the new one.
 */
export const MATCH_INPUT_SCHEME = 'v1';

/**
 * The job facts the matcher actually reads (see `MatchableJob` and the factors in
 * `score-match.ts`).
 *
 * Deliberately not the whole `MatchableJob`: `publishedDate.originalText` is stored but read by
 * no factor, and hashing it would write a new match row when only the raw text changed and the
 * score could not have moved.
 *
 * A `Date` would encode as `{}` under the canonical encoder, so the instant is rendered as an
 * ISO-8601 string. The evaluation clock is absent by construction — it is not an input here at
 * all, which is what keeps a freshness-only change from looking like new inputs.
 */
function scorableJob(job: MatchableJob): Record<string, unknown> {
  return {
    title: job.title,
    descriptionQuality: job.descriptionQuality,
    locationText: job.locationText,
    locationCategory: job.locationCategory,
    remoteStatus: job.remoteStatus,
    employmentType: job.employmentType,
    salaryType: job.salary.type,
    salaryMin: job.salary.min,
    salaryMax: job.salary.max,
    salaryCurrency: job.salary.currency,
    salaryPeriod: job.salary.period,
    salaryEvidence: job.salary.evidence,
    salaryConfidence: job.salary.confidence,
    publishedAt: job.publishedDate.publishedAt === null ? null : job.publishedDate.publishedAt.toISOString(),
    publishedCalendar: job.publishedDate.calendar,
    publishedConfidence: job.publishedDate.confidence,
    publishedConversionMethod: job.publishedDate.conversionMethod,
    skills: job.skills.map((skill) => ({
      canonicalSkill: skill.canonicalSkill,
      evidence: skill.evidence,
      confidence: skill.confidence,
    })),
    requiredExperience:
      job.requiredExperience === null
        ? null
        : { years: job.requiredExperience.years, confidence: job.requiredExperience.confidence },
  };
}

/**
 * Identity of one scoring input set: sha256 over the profile revision, the job facts that feed
 * scoring, and the matcher version (SRS 4.6 versioning; ADR-0005).
 *
 * It exists so re-scoring is idempotent without it being *coarse*: together with
 * (user, job, matcherVersion) it is the unique key of a stored match, so a profile edit or a
 * changed job produces a new row (history preserved) rather than overwriting the previous score,
 * while an unchanged input set re-finds its own row.
 *
 * `now` is not part of the input: freshness moves with the clock but the *inputs* have not
 * changed, so a re-score updates that row's output in place instead of inventing new inputs.
 */
export function matchInputHashOf(input: {
  profileVersion: string;
  matcherVersion: string;
  job: MatchableJob;
}): string {
  const digest = createHash('sha256')
    .update(
      canonicalEncode({
        scheme: MATCH_INPUT_SCHEME,
        profileVersion: input.profileVersion,
        matcherVersion: input.matcherVersion,
        job: scorableJob(input.job),
      }),
      'utf8',
    )
    .digest('hex');
  return `${MATCH_INPUT_SCHEME}:${digest.slice(0, 32)}`;
}
