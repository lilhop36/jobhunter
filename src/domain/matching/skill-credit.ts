import { SkillEvidence } from '@domain/enums';
import { Probability } from '@domain/types';

/**
 * SRS 4.6 "Skill credit": the credit a job-side skill observation earns against
 * a candidate skill, keyed by *how* the posting evidenced the skill.
 *
 * The SRS fixes the ladder qualitatively (full / partial capped / lower partial
 * capped / confidence-gated and capped) but not the numbers, so the caps are an
 * engineering decision recorded in ADR-0005.
 */
export const SKILL_CREDIT_V1: Readonly<Record<SkillEvidence, number>> = {
  [SkillEvidence.EXACT_MATCH]: 1,
  [SkillEvidence.CANONICAL_ALIAS]: 1,
  [SkillEvidence.RELATED_SKILL]: 0.5,
  [SkillEvidence.TRANSFERABLE]: 0.25,
  [SkillEvidence.AI_SUGGESTED]: 0.5,
  [SkillEvidence.UNKNOWN]: 0,
};

/**
 * Below this extraction confidence an `AI_SUGGESTED` skill earns no credit at
 * all ("confidence-gated"): advisory evidence must not move a score on its own
 * (ENG-007).
 */
export const AI_SUGGESTED_MIN_CONFIDENCE = 0.6;

/** Credit in [0, 1] for one job-side skill observation (SRS 4.6). */
export function skillCredit(evidence: SkillEvidence, confidence: Probability): number {
  if (evidence === SkillEvidence.AI_SUGGESTED) {
    return confidence < AI_SUGGESTED_MIN_CONFIDENCE ? 0 : SKILL_CREDIT_V1[evidence];
  }
  return SKILL_CREDIT_V1[evidence];
}
