import { EmploymentType, LocationCategory, RelocationPreference, RemotePreference, SalaryPeriod, SkillEvidence } from '../enums';
import { DecimalAmount } from './decimal-amount';
import { Probability } from './numeric-units';

/**
 * A candidate matching profile (FR-012) and its related entities
 * (SRS 5.2: CandidateProfile, CandidateSkill, TargetRole, LocationPreference).
 *
 * The model is per-candidate, and the vocabulary is field-agnostic: skills are
 * canonical names, roles are titles with aliases, locations are categories.
 * Nothing here privileges a job domain (software, health, construction, …).
 * v1 seeds one candidate (FR-012, Milestone 2), but the shape is general so a
 * second candidate is data, not a redesign.
 *
 * These are the *scoring inputs*: a frozen, evidence-free view of what the
 * candidate has declared. Values the candidate never stated are `null` or an
 * empty list — never a guess (ENG-001) — and the matcher treats them as UNKNOWN.
 *
 * The profile is versioned (`profileVersion`) because a stored JobMatch must be
 * reproducible against the profile that produced it (ENG-012).
 */

export interface CandidateSkill {
  /** Canonical skill name; matched case-insensitively against the job's skills. */
  canonicalSkill: string;
  /**
   * How the skill was established (SRS 5.2 `CandidateSkill.skillType`). The SRS
   * fixes the attribute but names no separate enum, so the Appendix A
   * `SkillEvidence` ladder is reused. On the candidate side it answers "how
   * firmly is this held", which is what `confidence` then quantifies.
   */
  skillType: SkillEvidence;
  /** How firmly the candidate holds this skill, in [0, 1]. Weights its credit. */
  confidence: Probability;
}

export interface TargetRole {
  title: string;
  /** Alternative spellings/titles that mean the same role. */
  aliases: readonly string[];
}

export interface LocationPreference {
  category: LocationCategory;
  /** Free-text place for a category the gazetteer cannot name; null when unused. */
  text: string | null;
}

export interface SalaryPreference {
  /** Minimum acceptable amount, exact decimal (ENG-006); null = no numeric floor. */
  min: DecimalAmount | null;
  /** Currency code the minimum is expressed in, or null when unstated. */
  currency: string | null;
  /** Pay period the minimum is expressed in, or null when unstated. */
  period: SalaryPeriod | null;
  /**
   * When true, an undisclosed salary is negative evidence rather than an
   * excluded factor (SRS 4.6 "Salary"). Defaults to false in the seeded profile.
   */
  requireDisclosed: boolean;
}

export interface CandidateProfile {
  /** Profile revision; a JobMatch records the version it was scored against. */
  profileVersion: string;
  /** Years of professional experience, or null when the candidate has not said. */
  experienceYears: number | null;
  remotePreference: RemotePreference;
  relocationPreference: RelocationPreference;
  /** Null when no salary expectation is declared. */
  salaryPreference: SalaryPreference | null;
  /** Employment types the candidate accepts; empty means "not stated". */
  employmentPreferences: readonly EmploymentType[];
  skills: readonly CandidateSkill[];
  targetRoles: readonly TargetRole[];
  locationPreferences: readonly LocationPreference[];
}
