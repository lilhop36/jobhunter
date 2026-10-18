import { Percent } from './numeric-units';

/**
 * Per-factor scores (SRS 5.2 `JobMatch.roleScore` … `salaryScore`).
 *
 * `null` means the factor had no usable evidence and was **excluded** from the
 * score and from the denominator (SRS 4.6 "UNKNOWN rule"), not that it scored
 * zero (AC-010: unknown is not negative evidence).
 */
export interface MatchFactorScores {
  role: Percent | null;
  skills: Percent | null;
  experience: Percent | null;
  location: Percent | null;
  employment: Percent | null;
  freshness: Percent | null;
  salary: Percent | null;
}

/**
 * The deterministic result of scoring one job against the candidate profile
 * (FR-013, FR-014, FR-015). Persistence adds `id`/`userId`/`jobId`/`createdAt`.
 *
 * `score` and `confidence` are both `Percent` (0–100, SRS B.3, ENG-028) but are
 * different quantities: `score` is relevance, `confidence` is evidence
 * completeness × extraction certainty. Neither is derived from the other.
 */
export interface JobMatch {
  score: Percent;
  confidence: Percent;
  factors: MatchFactorScores;
  matchedSkills: readonly string[];
  missingSkills: readonly string[];
  uncertainSkills: readonly string[];
  /** One line per matched observation, across all factors. */
  matchedEvidence: readonly string[];
  /** One line per expected observation the evidence contradicts or lacks. */
  missingEvidence: readonly string[];
  /** One line per excluded or low-confidence observation, with the reason. */
  uncertainEvidence: readonly string[];
  /** Deterministic, evidence-derived "why it matches" text (FR-015). */
  explanation: string;
  /** Matcher revision (ENG-013); any scoring change requires a new value. */
  matcherVersion: string;
}
