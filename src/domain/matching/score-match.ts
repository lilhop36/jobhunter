import {
  DescriptionQuality,
  EmploymentType,
  EvidenceState,
  LocationCategory,
  RelocationPreference,
  RemotePreference,
  RemoteStatus,
  SalaryType,
  SkillEvidence,
} from '@domain/enums';
import {
  asPercent,
  asProbability,
  CandidateProfile,
  compareDecimalAmount,
  DecimalAmount,
  JobMatch,
  MatchableJob,
  MatchFactorScores,
  Percent,
  Probability,
} from '@domain/types';
import { skillCredit } from './skill-credit';
import { MATCH_FACTORS, MATCH_FACTOR_WEIGHTS, MATCHER_VERSION } from './weights';

/**
 * Deterministic matcher (FR-013, FR-014, FR-015; SRS 4.6).
 *
 * Properties this function must keep, and which the tests pin:
 *
 *   - **Deterministic** (ENG-012, AC-009): a pure function of `profile`, `job`
 *     and the injected `now`. No clock, no randomness, no I/O, no AI.
 *   - **UNKNOWN is not negative** (AC-010): a factor with no evidence is
 *     excluded from both the numerator and the denominator and the remaining
 *     weights are renormalized (SRS 4.6 "UNKNOWN rule"). Confidence drops
 *     instead, which is what marks the result as thinly evidenced.
 *   - **Score and confidence are distinct** (ENG-028): `confidence` is evidence
 *     completeness × extraction certainty and is never derived from `score`.
 *   - **Total** (ENG-004): malformed or missing input yields UNKNOWN/0, never a
 *     throw.
 *
 * The numeric constants ADR-0005 records (partial-credit caps, freshness decay,
 * per-factor certainty) are hypotheses for the validation period (SRS 10.4),
 * not measured values.
 */

/** Below this many days a posting is fully fresh; at this many it scores 0. */
const FRESHNESS_FULL_DAYS = 7;
const FRESHNESS_ZERO_DAYS = 60;

/** How much a text-derived factor is trusted, by description quality. */
const TEXT_CERTAINTY: Readonly<Record<DescriptionQuality, number>> = {
  [DescriptionQuality.SUFFICIENT]: 0.9,
  [DescriptionQuality.PARTIAL]: 0.6,
  [DescriptionQuality.UNUSABLE]: 0.3,
};

const ROLE_EXACT_CERTAINTY = 0.95;
const ROLE_PARTIAL_CERTAINTY = 0.6;
/** A target role must cover at least this share of the title's role tokens. */
const ROLE_PARTIAL_MIN_RATIO = 0.5;
const LOCATION_CATEGORY_CERTAINTY = 0.9;
const LOCATION_TEXT_CERTAINTY = 0.6;
const EMPLOYMENT_TYPE_CERTAINTY = 0.9;
const ROLE_TOKEN_MIN_LENGTH = 3;

interface FactorOutcome {
  state: EvidenceState;
  /** 0–100. Meaningful only when `state` is KNOWN. */
  score: number;
  /** Extraction certainty of the evidence used, in [0, 1]. */
  certainty: number;
  matched: string[];
  missing: string[];
  uncertain: string[];
}

function unknown(reason: string): FactorOutcome {
  return { state: EvidenceState.UNKNOWN, score: 0, certainty: 0, matched: [], missing: [], uncertain: [reason] };
}

function known(
  score: number,
  certainty: number,
  evidence: { matched?: string[]; missing?: string[]; uncertain?: string[] } = {},
): FactorOutcome {
  return {
    state: EvidenceState.KNOWN,
    score: Math.min(100, Math.max(0, score)),
    certainty: Math.min(1, Math.max(0, certainty)),
    matched: evidence.matched ?? [],
    missing: evidence.missing ?? [],
    uncertain: evidence.uncertain ?? [],
  };
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Case/accent/punctuation-insensitive token form, Unicode-aware (Amharic titles). */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(text: string): string[] {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length >= ROLE_TOKEN_MIN_LENGTH);
}

/** True when `needle` occurs in `haystack` on token boundaries (both normalized). */
function containsPhrase(haystack: string, needle: string): boolean {
  const phrase = normalizeText(needle);
  if (phrase === '') return false;
  return ` ${normalizeText(haystack)} `.includes(` ${phrase} `);
}

/** Exact cents of a canonical amount; safe integer arithmetic (ENG-006). */
function scaledAmount(amount: DecimalAmount): number {
  const [whole, fraction = ''] = amount.split('.');
  return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
}

// ── factors ─────────────────────────────────────────────────────────────────

function scoreRole(profile: CandidateProfile, job: MatchableJob): FactorOutcome {
  if (!hasText(job.title)) return unknown('role: the posting states no title');
  if (profile.targetRoles.length === 0) return unknown('role: no target roles are configured');

  const titleTokens = new Set(tokens(job.title));
  let bestScore = 0;
  let bestRole: string | null = null;
  let bestKind: 'none' | 'exact' | 'partial' = 'none';

  for (const role of profile.targetRoles) {
    if (!hasText(role.title)) continue;
    for (const name of [role.title, ...role.aliases]) {
      if (!hasText(name)) continue;
      if (containsPhrase(job.title, name)) {
        bestScore = 100;
        bestRole = role.title;
        bestKind = 'exact';
        break;
      }
    }
    if (bestKind === 'exact') break;

    const roleTokens = [...new Set(tokens(role.title))];
    if (roleTokens.length === 0) continue;
    const hits = roleTokens.filter((token) => titleTokens.has(token)).length;
    const ratio = hits / roleTokens.length;
    if (ratio < ROLE_PARTIAL_MIN_RATIO) continue;
    const score = Math.round(ratio * 100);
    if (score > bestScore) {
      bestScore = score;
      bestRole = role.title;
      bestKind = 'partial';
    }
  }

  if (bestKind === 'none') {
    return known(0, ROLE_EXACT_CERTAINTY, {
      missing: [`role: the title "${job.title}" matches none of the configured target roles`],
    });
  }
  return known(bestScore, bestKind === 'exact' ? ROLE_EXACT_CERTAINTY : ROLE_PARTIAL_CERTAINTY, {
    matched: [`role: "${job.title}" matches target role "${bestRole}"`],
  });
}

function scoreSkills(profile: CandidateProfile, job: MatchableJob): FactorOutcome {
  const candidateSkills = profile.skills.filter((skill) => hasText(skill.canonicalSkill));
  if (candidateSkills.length === 0) return unknown('skills: no candidate skills are configured');
  if (job.skills.length === 0) return unknown('skills: the posting evidences no skills');

  const jobSkills = new Map(
    job.skills.filter((skill) => hasText(skill.canonicalSkill)).map((skill) => [
      normalizeText(skill.canonicalSkill),
      skill,
    ]),
  );

  let weightTotal = 0;
  let creditTotal = 0;
  const matched: string[] = [];
  const missing: string[] = [];
  const uncertain: string[] = [];

  for (const candidate of candidateSkills) {
    // How firmly the candidate holds the skill weights how much its credit counts.
    const weight = candidate.confidence;
    weightTotal += weight;

    const jobSkill = jobSkills.get(normalizeText(candidate.canonicalSkill));
    if (jobSkill === undefined) {
      missing.push(candidate.canonicalSkill);
      continue;
    }

    creditTotal += weight * skillCredit(jobSkill.evidence, jobSkill.confidence);
    if (jobSkill.evidence === SkillEvidence.AI_SUGGESTED) {
      uncertain.push(`${candidate.canonicalSkill} (AI_SUGGESTED, confidence ${jobSkill.confidence})`);
    } else {
      matched.push(`${candidate.canonicalSkill} (${jobSkill.evidence})`);
    }
  }

  if (weightTotal === 0) return unknown('skills: candidate skills carry no confidence weight');

  return known(Math.round((100 * creditTotal) / weightTotal), TEXT_CERTAINTY[job.descriptionQuality], {
    matched: matched.sort(),
    missing: missing.sort(),
    uncertain: uncertain.sort(),
  });
}

function scoreExperience(profile: CandidateProfile, job: MatchableJob): FactorOutcome {
  const required = job.requiredExperience;
  if (required === null) return unknown('experience: the posting states no required experience');
  if (!Number.isFinite(required.years) || required.years < 0) {
    return unknown('experience: the stated required experience is not a usable number');
  }
  if (profile.experienceYears === null || !Number.isFinite(profile.experienceYears)) {
    return unknown('experience: the profile states no experience');
  }

  const line = `experience: posting requires ${required.years} year(s), profile states ${profile.experienceYears}`;
  const meets = profile.experienceYears >= required.years;
  const score = meets ? 100 : Math.round((100 * profile.experienceYears) / required.years);
  return known(score, required.confidence, meets ? { matched: [line] } : { missing: [line] });
}

function scoreLocation(profile: CandidateProfile, job: MatchableJob): FactorOutcome {
  const { remoteStatus, locationCategory } = job;
  if (remoteStatus === RemoteStatus.UNKNOWN && locationCategory === LocationCategory.UNKNOWN) {
    return unknown('location: the posting states no place of work');
  }

  // Exclusions first: only an exclusive preference contradicts a job (SRS 4.6 "Remote").
  if (profile.remotePreference === RemotePreference.REMOTE_REQUIRED && remoteStatus === RemoteStatus.ONSITE) {
    return known(0, LOCATION_CATEGORY_CERTAINTY, {
      missing: ['location: remote work is required but the posting is on-site'],
    });
  }
  if (profile.remotePreference === RemotePreference.ONSITE_ONLY && remoteStatus === RemoteStatus.REMOTE) {
    return known(0, LOCATION_CATEGORY_CERTAINTY, {
      missing: ['location: on-site work is required but the posting is remote'],
    });
  }

  if (remoteStatus === RemoteStatus.REMOTE || remoteStatus === RemoteStatus.HYBRID) {
    const remote = remoteStatus === RemoteStatus.REMOTE;
    const prefersRemote =
      profile.remotePreference === RemotePreference.REMOTE_REQUIRED ||
      profile.remotePreference === RemotePreference.REMOTE_PREFERRED;
    // Hybrid is a compromise: full credit only when the candidate welcomes remote work,
    // partial for an on-site-only candidate, neutral when no preference was stated.
    const score = remote ? 100 : prefersRemote ? 90 : profile.remotePreference === RemotePreference.ONSITE_ONLY ? 50 : 100;
    return known(score, LOCATION_CATEGORY_CERTAINTY, { matched: [`location: ${remote ? 'remote' : 'hybrid'} work`] });
  }

  // On-site: match the posting's place against the preferred places.
  if (profile.locationPreferences.length === 0) {
    return unknown('location: no location preferences are configured');
  }

  const locationText = job.locationText;
  const matchesPreferredText =
    hasText(locationText) &&
    profile.locationPreferences.some(
      (preference) => hasText(preference.text) && containsPhrase(locationText, preference.text),
    );

  if (locationCategory === LocationCategory.UNKNOWN) {
    if (matchesPreferredText && hasText(locationText)) {
      return known(100, LOCATION_TEXT_CERTAINTY, {
        matched: [`location: "${locationText}" matches a preferred place`],
      });
    }
    return unknown(`location: the stated place "${locationText ?? ''}" is not recognised`);
  }

  if (profile.locationPreferences.some((preference) => preference.category === locationCategory)) {
    return known(100, LOCATION_CATEGORY_CERTAINTY, { matched: [`location: ${locationCategory}`] });
  }
  if (matchesPreferredText && hasText(locationText)) {
    return known(100, LOCATION_TEXT_CERTAINTY, {
      matched: [`location: "${locationText}" matches a preferred place`],
    });
  }

  const line = `location: ${locationCategory} is outside the preferred locations`;
  if (profile.relocationPreference === RelocationPreference.WILLING) {
    return known(50, LOCATION_CATEGORY_CERTAINTY, {
      uncertain: [`${line}; relocation is acceptable, scored partially`],
    });
  }
  return known(0, LOCATION_CATEGORY_CERTAINTY, { missing: [line] });
}

function scoreEmployment(profile: CandidateProfile, job: MatchableJob): FactorOutcome {
  if (job.employmentType === EmploymentType.UNKNOWN) {
    return unknown('employment: the posting states no employment type');
  }
  if (profile.employmentPreferences.length === 0) {
    return unknown('employment: no employment preferences are configured');
  }
  if (profile.employmentPreferences.includes(job.employmentType)) {
    return known(100, EMPLOYMENT_TYPE_CERTAINTY, { matched: [`employment: ${job.employmentType}`] });
  }
  return known(0, EMPLOYMENT_TYPE_CERTAINTY, {
    missing: [`employment: ${job.employmentType} is not among the accepted employment types`],
  });
}

function scoreFreshness(job: MatchableJob, now: Date): FactorOutcome {
  const publishedAt = job.publishedDate.publishedAt;
  if (publishedAt === null || Number.isNaN(publishedAt.getTime())) {
    return unknown('freshness: the posting date is unknown');
  }
  if (Number.isNaN(now.getTime())) return unknown('freshness: no evaluation time was supplied');

  const ageDays = Math.max(0, (now.getTime() - publishedAt.getTime()) / 86_400_000);
  const decayed =
    ageDays <= FRESHNESS_FULL_DAYS
      ? 100
      : ageDays >= FRESHNESS_ZERO_DAYS
        ? 0
        : Math.round((100 * (FRESHNESS_ZERO_DAYS - ageDays)) / (FRESHNESS_ZERO_DAYS - FRESHNESS_FULL_DAYS));

  const line = `freshness: published ${Math.floor(ageDays)} day(s) before evaluation`;
  return known(decayed, job.publishedDate.confidence, decayed > 0 ? { matched: [line] } : { missing: [line] });
}

function scoreSalary(profile: CandidateProfile, job: MatchableJob): FactorOutcome {
  const preference = profile.salaryPreference;
  if (preference === null) return unknown('salary: no salary preference is configured');

  const salary = job.salary;
  const disclosedType =
    salary.type === SalaryType.EXACT ||
    salary.type === SalaryType.RANGE ||
    salary.type === SalaryType.STARTING_FROM ||
    salary.type === SalaryType.UP_TO;
  const amount = salary.min ?? salary.max;

  if (!disclosedType || amount === null || salary.min === null) {
    if (preference.requireDisclosed) {
      return known(0, 1, {
        missing: [`salary: the posting reports ${salary.type} and a disclosed salary is required`],
      });
    }
    return unknown(`salary: ${salary.type} is excluded from scoring`);
  }

  if (preference.min === null) {
    return unknown('salary: the profile states no minimum to compare against');
  }
  if (
    hasText(preference.currency) &&
    hasText(salary.currency) &&
    preference.currency.toUpperCase() !== salary.currency.toUpperCase()
  ) {
    return unknown(`salary: currency ${salary.currency} differs from the preferred ${preference.currency}`);
  }
  if (preference.period !== null && salary.period !== null && preference.period !== salary.period) {
    return unknown(`salary: period ${salary.period} differs from the preferred ${preference.period}`);
  }

  const meets = compareDecimalAmount(salary.min, preference.min) >= 0;
  const line = `salary: posting offers at least ${salary.min}${salary.currency ? ` ${salary.currency}` : ''}, preferred minimum ${preference.min}`;
  if (meets) return known(100, salary.confidence, { matched: [line] });

  const ratio = scaledAmount(salary.min) / scaledAmount(preference.min);
  return known(Math.round(100 * ratio), salary.confidence, { missing: [line] });
}

// ── entry point ─────────────────────────────────────────────────────────────

export interface MatchInput {
  profile: CandidateProfile;
  job: MatchableJob;
  /** Injected evaluation time (ENG-012): the matcher never reads the clock. */
  now: Date;
}

function toPercent(outcome: FactorOutcome): Percent | null {
  return outcome.state === EvidenceState.KNOWN ? asPercent(outcome.score) : null;
}

/**
 * Scores one job against the profile (FR-013) and explains it (FR-015).
 *
 * `score` renormalizes over the factors that had evidence; `confidence` is
 * `knownWeight/totalWeight × weighted extraction certainty` as a `Percent`.
 */
export function scoreMatch(input: MatchInput): JobMatch {
  const { profile, job, now } = input;

  const outcomes: Readonly<Record<string, FactorOutcome>> = {
    role: scoreRole(profile, job),
    skills: scoreSkills(profile, job),
    experience: scoreExperience(profile, job),
    location: scoreLocation(profile, job),
    employment: scoreEmployment(profile, job),
    freshness: scoreFreshness(job, now),
    salary: scoreSalary(profile, job),
  };

  let knownWeight = 0;
  let weightedScore = 0;
  let weightedCertainty = 0;
  const knownNames: string[] = [];
  const excludedNames: string[] = [];
  const matchedEvidence: string[] = [];
  const missingEvidence: string[] = [];
  const uncertainEvidence: string[] = [];

  for (const factor of MATCH_FACTORS) {
    const outcome = outcomes[factor];
    matchedEvidence.push(...outcome.matched);
    missingEvidence.push(...outcome.missing);
    uncertainEvidence.push(...outcome.uncertain);

    if (outcome.state === EvidenceState.CONFLICTING) {
      // ENG-005: conflicting evidence is surfaced, never resolved by guessing.
      excludedNames.push(`${factor} (CONFLICTING)`);
      continue;
    }
    if (outcome.state !== EvidenceState.KNOWN) {
      excludedNames.push(factor);
      continue;
    }

    const weight = MATCH_FACTOR_WEIGHTS[factor];
    knownWeight += weight;
    weightedScore += outcome.score * weight;
    weightedCertainty += outcome.certainty * weight;
    knownNames.push(`${factor} ${outcome.score}`);
  }

  const totalWeight = MATCH_FACTORS.reduce((sum, factor) => sum + MATCH_FACTOR_WEIGHTS[factor], 0);
  const score = knownWeight === 0 ? 0 : Math.round(weightedScore / knownWeight);
  const completeness = totalWeight === 0 ? 0 : knownWeight / totalWeight;
  const certainty: Probability = asProbability(knownWeight === 0 ? 0 : weightedCertainty / knownWeight);
  const confidence = Math.round(100 * completeness * certainty);

  const factors: MatchFactorScores = {
    role: toPercent(outcomes.role),
    skills: toPercent(outcomes.skills),
    experience: toPercent(outcomes.experience),
    location: toPercent(outcomes.location),
    employment: toPercent(outcomes.employment),
    freshness: toPercent(outcomes.freshness),
    salary: toPercent(outcomes.salary),
  };

  const explanationParts = [
    `${score}/100 relevance, ${confidence}% confidence (matcher ${MATCHER_VERSION})`,
    knownNames.length > 0 ? `known factors: ${knownNames.join(', ')}` : 'no factor had usable evidence',
    excludedNames.length > 0 ? `excluded (unknown evidence): ${excludedNames.join(', ')}` : '',
    matchedEvidence.length > 0 ? `matched: ${matchedEvidence.join('; ')}` : '',
    missingEvidence.length > 0 ? `missing: ${missingEvidence.join('; ')}` : '',
    uncertainEvidence.length > 0 ? `uncertain: ${uncertainEvidence.join('; ')}` : '',
  ].filter((part) => part !== '');

  return {
    score: asPercent(score),
    confidence: asPercent(confidence),
    factors,
    matchedSkills: outcomes.skills.matched.map((line) => line.replace(/\s*\(.*$/, '')).sort(),
    missingSkills: [...outcomes.skills.missing].sort(),
    uncertainSkills: outcomes.skills.uncertain.map((line) => line.replace(/\s*\(.*$/, '')).sort(),
    matchedEvidence,
    missingEvidence,
    uncertainEvidence,
    explanation: `${explanationParts.join('. ')}.`,
    matcherVersion: MATCHER_VERSION,
  };
}
