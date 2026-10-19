import { ApplicationMethod, SalaryPeriod, SalaryType } from '../enums';

/**
 * Rendering a notification message (SRS 3.2 "Content").
 *
 * The message is rendered from **stored** facts at delivery time: the outbox payload written
 * with the match, the job it names, and the source. Nothing here re-scores, re-parses a posting,
 * or invents a field (ENG-001/ENG-016) — and a value the job does not have is rendered as
 * UNKNOWN rather than omitted or guessed, so a reader can tell "not stated" from "not shown".
 *
 * The payload is untrusted stored JSON (it was written by an earlier revision of the code), so it
 * is read defensively: anything unrecognisable becomes null instead of throwing or being
 * interpreted as zero.
 */

/** What the message renderer knows about the match, read defensively out of the payload. */
export interface NotificationEvidence {
  score: number | null;
  confidence: number | null;
  explanation: string | null;
  matcherVersion: string | null;
  eligibilityExplanation: string | null;
  matchedSkills: readonly string[];
  missingSkills: readonly string[];
  uncertainSkills: readonly string[];
}

function readNumber(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readTextArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function readNotificationEvidence(payload: unknown): NotificationEvidence {
  const empty: NotificationEvidence = {
    score: null,
    confidence: null,
    explanation: null,
    matcherVersion: null,
    eligibilityExplanation: null,
    matchedSkills: [],
    missingSkills: [],
    uncertainSkills: [],
  };
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return empty;
  const doc = payload as Record<string, unknown>;
  return {
    score: readNumber(doc.score, 100),
    confidence: readNumber(doc.confidence, 100),
    explanation: readText(doc.explanation),
    matcherVersion: readText(doc.matcherVersion),
    eligibilityExplanation: readText(doc.eligibilityExplanation),
    matchedSkills: readTextArray(doc.matchedSkills),
    missingSkills: readTextArray(doc.missingSkills),
    uncertainSkills: readTextArray(doc.uncertainSkills),
  };
}

/** The job facts SRS 3.2 asks the message to carry. Amounts are exact decimal strings (ENG-006). */
export interface NotificationMessageContent {
  title: string | null;
  company: string | null;
  locationText: string | null;
  salary: {
    type: SalaryType;
    min: string | null;
    max: string | null;
    currency: string | null;
    period: SalaryPeriod;
  } | null;
  application: {
    method: ApplicationMethod;
    applyUrl: string | null;
    applyEmail: string | null;
  };
  sourceName: string;
  evidence: NotificationEvidence;
}

const PERIODS: Readonly<Record<SalaryPeriod, string>> = {
  [SalaryPeriod.HOUR]: 'hour',
  [SalaryPeriod.DAY]: 'day',
  [SalaryPeriod.WEEK]: 'week',
  [SalaryPeriod.MONTH]: 'month',
  [SalaryPeriod.YEAR]: 'year',
  [SalaryPeriod.OTHER]: 'period stated by the source',
  [SalaryPeriod.UNKNOWN]: 'period not stated',
};

function formatSalary(salary: NonNullable<NotificationMessageContent['salary']>): string {
  const currency = salary.currency ?? '';
  const per = PERIODS[salary.period];
  const amount = (value: string | null): string | null =>
    value === null ? null : `${value}${currency === '' ? '' : ` ${currency}`}`;

  const min = amount(salary.min);
  const max = amount(salary.max);
  switch (salary.type) {
    case SalaryType.EXACT:
      return min === null ? 'amount not stated' : `${min} per ${per}`;
    case SalaryType.RANGE:
      return min === null || max === null ? 'range not fully stated' : `${min} – ${max} per ${per}`;
    case SalaryType.STARTING_FROM:
      return min === null ? 'starting amount not stated' : `from ${min} per ${per}`;
    case SalaryType.UP_TO:
      return max === null ? 'maximum not stated' : `up to ${max} per ${per}`;
    case SalaryType.NEGOTIABLE:
      return 'negotiable';
    case SalaryType.AS_PER_SCALE:
      return 'as per scale';
    case SalaryType.NOT_DISCLOSED:
      return 'not disclosed';
    case SalaryType.UNKNOWN:
      return 'UNKNOWN';
  }
}

function formatApplication(application: NotificationMessageContent['application']): string {
  switch (application.method) {
    case ApplicationMethod.ONLINE_URL:
      return application.applyUrl ?? 'UNKNOWN (no URL recorded)';
    case ApplicationMethod.PDF_FORM:
      return application.applyUrl ?? 'UNKNOWN (no form recorded)';
    case ApplicationMethod.EMAIL:
      return application.applyEmail ?? 'UNKNOWN (no address recorded)';
    case ApplicationMethod.SOURCE_ACCOUNT:
      return 'on the source site (an account is required)';
    case ApplicationMethod.IN_PERSON:
      return 'in person';
    case ApplicationMethod.INSTRUCTIONS:
      return 'following the listing instructions';
    case ApplicationMethod.UNKNOWN:
      return 'UNKNOWN';
  }
}

function skillLines(evidence: NotificationEvidence): string[] {
  const all = [...evidence.matchedSkills, ...evidence.missingSkills, ...evidence.uncertainSkills];
  if (all.length === 0) {
    // ADR-0005 §2: no stage extracts skills from a posting yet. Saying "none" would be a claim
    // about the job; saying this is a claim about the pipeline, which is the true one.
    return ['Skills: not extracted from this posting yet'];
  }
  const lines: string[] = [];
  if (evidence.matchedSkills.length > 0) {
    lines.push(`Matched skills: ${evidence.matchedSkills.join(', ')}`);
  }
  if (evidence.missingSkills.length > 0) {
    lines.push(`Missing skills: ${evidence.missingSkills.join(', ')}`);
  }
  if (evidence.uncertainSkills.length > 0) {
    lines.push(`Uncertain skills: ${evidence.uncertainSkills.join(', ')}`);
  }
  return lines;
}

/**
 * The message text, one line per SRS 3.2 content item, in that order. Deterministic: the same
 * stored rows always render the same text, so a delivery can be reproduced from the database.
 */
export function renderNotificationMessage(content: NotificationMessageContent): string {
  const { evidence } = content;
  const lines = [
    `Job: ${content.title ?? 'UNKNOWN'}`,
    `Company: ${content.company ?? 'UNKNOWN'}`,
    `Location: ${content.locationText ?? 'UNKNOWN'}`,
    evidence.score === null && evidence.confidence === null
      ? 'Match: UNKNOWN (the stored match carried no score)'
      : `Match: ${evidence.score ?? 'UNKNOWN'}/100 relevance, ${evidence.confidence ?? 'UNKNOWN'}% confidence`,
    `Why it matches: ${evidence.explanation ?? 'UNKNOWN'}`,
    ...skillLines(evidence),
    `Salary: ${content.salary === null ? 'UNKNOWN' : formatSalary(content.salary)}`,
    `Apply: ${formatApplication(content.application)}`,
    `Source: ${content.sourceName}`,
  ];
  return lines.join('\n');
}
