import {
  DescriptionQuality,
  EmploymentType,
  LocationCategory,
  RemoteStatus,
  SkillEvidence,
} from '../enums';
import { DateParsed } from './date-parsed';
import { Probability } from './numeric-units';
import { SalaryParsed } from './salary-parsed';

/**
 * One skill evidenced in a posting, produced by the deterministic skill
 * extraction stage. `evidence` is *how* the posting evidences the skill, which
 * is what the Appendix A credit ladder scores; it is never inferred here.
 */
export interface MatchableJobSkill {
  canonicalSkill: string;
  evidence: SkillEvidence;
  /** Extraction confidence in [0, 1]; gates `AI_SUGGESTED` credit. */
  confidence: Probability;
}

export interface RequiredExperience {
  years: number;
  /** Extraction confidence in [0, 1]. */
  confidence: Probability;
}

/**
 * The scoring view of one normalized `Job`. Only facts already derived and
 * stored on the Job are present — the matcher parses no text and invents no
 * field (ENG-001, ENG-016).
 */
export interface MatchableJob {
  title: string | null;
  /** Drives how much the text-derived factors are trusted, not their score. */
  descriptionQuality: DescriptionQuality;
  locationText: string | null;
  locationCategory: LocationCategory;
  remoteStatus: RemoteStatus;
  employmentType: EmploymentType;
  salary: SalaryParsed;
  publishedDate: DateParsed;
  skills: readonly MatchableJobSkill[];
  /** Null when the posting states no required experience (UNKNOWN). */
  requiredExperience: RequiredExperience | null;
}
