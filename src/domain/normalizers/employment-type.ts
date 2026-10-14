import { EmploymentType } from '../enums';

/**
 * Deterministic employment-type extraction (FR-009 / SRS 7.7 step 6).
 *
 * The SRS fixes the `EmploymentType` values (Appendix A) and requires key fields to be
 * "extracted deterministically when possible" (FR-009), but does not define the checks.
 * This module is that policy, and it is deliberately *high precision, low recall*: an
 * employment type is derived only from an explicit signal, and the result is UNKNOWN
 * otherwise. Guessing an employer's arrangement from prose would fabricate a job fact
 * (ER-04), and a missing type is a valid state (ENG-001) - a wrong one is not.
 *
 * `EMPLOYMENT_TYPE_V1` signals, strongest first:
 *  1. a labeled field in the description or title, e.g. "Employment Type: Contract",
 *     "Job Type: Full-time", "Contract type - Temporary";
 *  2. an explicit token in the title, e.g. "Backend Engineer (Contract)", "… Internship";
 *  3. otherwise UNKNOWN.
 *
 * The description body is *not* scanned for bare tokens: "full-time benefits" in an
 * otherwise contract posting would misclassify the job. Title token matching and labeled
 * fields are the evidence, not the surrounding prose.
 *
 * `ponytail:` title + labeled-field only. When recall measurably matters, add more labeled
 * variants ("Terms:", "Position type:") rather than loosening to description-wide matching,
 * and bump the version.
 */

/** Bump with any change to the rules below. */
export const EMPLOYMENT_TYPE_VERSION = 'EMPLOYMENT_TYPE_V1';

interface EmploymentTypeRule {
  readonly type: EmploymentType;
  readonly pattern: RegExp;
}

/**
 * Ordered most-specific engagement nature first. Contract/temporary/freelance/internship
 * describe the *nature* of the engagement and can co-occur with the full/part-time split
 * ("Full-time contract", "Part-time internship"), so the nature wins; the work-pattern
 * split is left last.
 */
const RULES: readonly EmploymentTypeRule[] = [
  { type: EmploymentType.INTERNSHIP, pattern: /\bintern(ship)?\b/iu },
  { type: EmploymentType.TEMPORARY, pattern: /\btemporary\b|\btemp\b|\bfixed[\s-]?term\b/iu },
  { type: EmploymentType.FREELANCE, pattern: /\bfreelanc(e|er|ing)\b/iu },
  { type: EmploymentType.CONTRACT, pattern: /\bcontract(or|s|ual)?\b|\bconsultanc(y|t)\b/iu },
  { type: EmploymentType.PART_TIME, pattern: /\bpart[\s-]?time\b/iu },
  { type: EmploymentType.FULL_TIME, pattern: /\bfull[\s-]?time\b/iu },
];

/** "Employment Type: X" / "Job Type - X" / "Contract type – X". */
const LABELED_FIELD = /\b(?:employment|job|contract)\s*type\s*[:\-\u2013\u2014]\s*([^\n.;,]{1,40})/iu;

function firstMatch(text: string): { type: EmploymentType; evidence: string } | null {
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) return { type: rule.type, evidence: match[0] };
  }
  return null;
}

export interface EmploymentTypeInput {
  title?: string | null;
  description?: string | null;
}

export interface EmploymentTypeResult {
  type: EmploymentType;
  /** The exact source slice that determined the type, or null when UNKNOWN. */
  evidence: string | null;
}

/**
 * Extract the employment type from captured evidence. Pure and deterministic: no clock,
 * locale or randomness (ENG-012, ER-63), and untrusted input never throws (ER-24).
 */
export function classifyEmploymentType(input: EmploymentTypeInput): EmploymentTypeResult {
  const title = typeof input.title === 'string' ? input.title : '';
  const description = typeof input.description === 'string' ? input.description : '';

  // 1. A labeled field is the strongest signal, so it outranks a bare title token.
  const labeled = LABELED_FIELD.exec(description) ?? LABELED_FIELD.exec(title);
  if (labeled) {
    const value = firstMatch(labeled[1]);
    if (value) return { type: value.type, evidence: labeled[0].trim() };
  }

  // 2. An explicit token in the title.
  const fromTitle = firstMatch(title);
  if (fromTitle) return { type: fromTitle.type, evidence: fromTitle.evidence };

  // 3. No explicit signal: UNKNOWN, never a guess.
  return { type: EmploymentType.UNKNOWN, evidence: null };
}
