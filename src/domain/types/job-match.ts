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

/**
 * Revision of the stored evidence document. A shape change (not a scoring change)
 * bumps this; the reader rejects a version it does not know rather than guessing.
 */
export const JOB_MATCH_EVIDENCE_VERSION = 1;

/**
 * The typed evidence document persisted in `job_matches.evidence` (SRS 5.2
 * `matchedEvidence` / `missingEvidence` / `uncertainEvidence`; FR-015).
 *
 * The skill-named subset is carried *structurally* under `skills`, alongside the
 * statement lines it belongs to — it is never re-parsed back out of those lines, so a
 * stored match does not depend on the wording of its own prose.
 */
export interface JobMatchEvidence {
  version: typeof JOB_MATCH_EVIDENCE_VERSION;
  matched: readonly string[];
  missing: readonly string[];
  uncertain: readonly string[];
  skills: {
    readonly matched: readonly string[];
    readonly missing: readonly string[];
    readonly uncertain: readonly string[];
  };
}

/** Build the stored evidence document from a scored match. Key order is fixed so the
 * document is byte-stable for the write-if-changed comparison. */
export function jobMatchEvidenceOf(match: JobMatch): JobMatchEvidence {
  return {
    version: JOB_MATCH_EVIDENCE_VERSION,
    matched: [...match.matchedEvidence],
    missing: [...match.missingEvidence],
    uncertain: [...match.uncertainEvidence],
    skills: {
      matched: [...match.matchedSkills],
      missing: [...match.missingSkills],
      uncertain: [...match.uncertainSkills],
    },
  };
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : null;
}

/**
 * Validate an untrusted stored document on read. Returns null for anything that is not
 * exactly a known version's shape — a corrupt row must fail loudly at the boundary, never
 * be interpreted as a mostly-empty match.
 */
export function parseJobMatchEvidence(value: unknown): JobMatchEvidence | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (doc.version !== JOB_MATCH_EVIDENCE_VERSION) return null;

  const matched = readStringArray(doc.matched);
  const missing = readStringArray(doc.missing);
  const uncertain = readStringArray(doc.uncertain);
  if (matched === null || missing === null || uncertain === null) return null;

  const skillsRaw = doc.skills;
  if (skillsRaw === null || typeof skillsRaw !== 'object' || Array.isArray(skillsRaw)) return null;
  const skills = skillsRaw as Record<string, unknown>;
  const skillMatched = readStringArray(skills.matched);
  const skillMissing = readStringArray(skills.missing);
  const skillUncertain = readStringArray(skills.uncertain);
  if (skillMatched === null || skillMissing === null || skillUncertain === null) return null;

  return {
    version: JOB_MATCH_EVIDENCE_VERSION,
    matched,
    missing,
    uncertain,
    skills: { matched: skillMatched, missing: skillMissing, uncertain: skillUncertain },
  };
}
