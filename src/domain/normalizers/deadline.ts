import { CalendarType } from '@domain/enums';
import type { DeadlineParsed, DeclaredDateFormat } from '@domain/types';
import { parseDate } from './calendar';

/**
 * Application-deadline extraction (FR-019, SRS 4.4; "no invented deadline", SRS 9.1).
 *
 * A deadline is a *stated* fact or it is UNKNOWN. The rule is therefore narrow: find a label
 * that names a deadline, then hand the text immediately after that label to the shared,
 * versioned date parser. Nothing else is considered — not the posting's age, not an unlabelled
 * date, not a duration such as "within 7 working days" (resolving that would invent both the
 * reference day and the working-day calendar).
 *
 * Consequences worth stating because they look like gaps:
 *  - A posting with no labelled date yields `deadlineAt: null` (UNKNOWN), not a guess.
 *  - A numeric date such as `30/10/2026` stays UNKNOWN unless the source declared both its
 *    calendar and its numeric format, exactly as `parseDate` requires for publication dates.
 *  - Only English labels are recognised. A source that states deadlines in another language
 *    yields UNKNOWN rather than a silent miss being read as "no deadline"; add its labels here
 *    once a source that does so is approved.
 */
export const DEADLINE_EXTRACTION_VERSION = 'DEADLINE_EXTRACTION_V1';

/**
 * Labels that introduce a deadline, longest first so `application deadline` wins over
 * `deadline` and the captured evidence keeps the more specific phrase.
 */
const DEADLINE_LABELS: readonly string[] = [
  'application deadline',
  'deadline for application',
  'deadline for applications',
  'submission deadline',
  'applications close',
  'application closes',
  'applications must be submitted by',
  'last date for application',
  'last date of application',
  'closing date',
  'apply on or before',
  'apply before',
  'apply until',
  'apply by',
  'deadline',
];

/** How much text after a label is offered to the date parser. One line, one clause. */
const MAX_PHRASE_LENGTH = 80;

const LABEL_PATTERN = new RegExp(`(?:${DEADLINE_LABELS.join('|')})\\s*[:\\-–]?\\s*`, 'gi');

export interface DeadlineParseInput {
  description: string | null | undefined;
  /** Declared source calendar, passed through as the explicit signal it is (Appendix E). */
  sourceCalendarHint?: CalendarType | null;
  declaredDateFormat?: DeclaredDateFormat | null;
}

const NO_DEADLINE: DeadlineParsed = {
  deadlineAt: null,
  evidence: null,
  conversionMethod: null,
};

/** The text after a label, cut at the line end and bounded so one label reads one clause. */
function phraseAfter(text: string, index: number, labelLength: number): string {
  return lineFrom(text, index + labelLength).slice(0, MAX_PHRASE_LENGTH).trim();
}

function lineFrom(text: string, start: number): string {
  const lineEnd = text.indexOf('\n', start);
  return lineEnd === -1 ? text.slice(start) : text.slice(start, lineEnd);
}

/**
 * Read the first labelled deadline in a description. Total: never throws, and anything it
 * cannot establish stays null (ENG-001).
 */
export function parseDeadline(input: DeadlineParseInput): DeadlineParsed {
  const description = input.description;
  if (typeof description !== 'string' || description.trim().length === 0) return NO_DEADLINE;

  LABEL_PATTERN.lastIndex = 0;
  let label: RegExpExecArray | null;
  while ((label = LABEL_PATTERN.exec(description)) !== null) {
    const phrase = phraseAfter(description, label.index, label[0].length);
    if (phrase.length === 0) continue;

    const parsed = parseDate({
      text: phrase,
      sourceCalendarHint: input.sourceCalendarHint ?? null,
      declaredDateFormat: input.declaredDateFormat ?? null,
      // A relative deadline ("in two weeks") is not resolvable without inventing its
      // reference point, so no collection time is offered here.
      collectedAt: null,
    });
    if (parsed.publishedAt === null) continue;

    return {
      deadlineAt: parsed.publishedAt,
      evidence: `${label[0].trim()} ${phrase}`.trim(),
      conversionMethod: parsed.conversionMethod,
    };
  }

  return NO_DEADLINE;
}
