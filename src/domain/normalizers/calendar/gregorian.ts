import { CalendarType } from '@domain/enums';
import { asProbability, DateParsed, DeclaredDateFormat, Probability } from '@domain/types';

/**
 * Gregorian date normalizer (SRS Appendix E, "Calendar detection").
 *
 * Precedence, most explicit first:
 *   1. ISO 8601 (`2025-09-15`) — unambiguous.
 *   2. A month *name* with a day and a four-digit year (`15 Sep 2025`,
 *      `September 15, 2025`) — unambiguous, English month names only.
 *   3. A relative expression (`3 days ago`, `yesterday`) — resolved against the
 *      injected `collectedAt` with reduced confidence.
 *   4. A numeric-only date (`05/01/2025`) — accepted *only* when the adapter has
 *      declared both the calendar and the date format; otherwise UNKNOWN.
 *
 * Output is date-only (UTC midnight) and never timezone-converted. The function
 * is total: it never throws, and anything it cannot establish is UNKNOWN with
 * `publishedAt: null` (ENG-001, ENG-004).
 */

export const GREGORIAN_ISO_VERSION = 'GREGORIAN_ISO_V1';
export const GREGORIAN_NAMED_MONTH_VERSION = 'GREGORIAN_NAMED_MONTH_V1';
export const GREGORIAN_RELATIVE_VERSION = 'GREGORIAN_RELATIVE_V1';
export const GREGORIAN_DECLARED_FORMAT_VERSION = 'GREGORIAN_DECLARED_FORMAT_V1';

export interface GregorianMonthName {
  month: number;
  names: string[];
}

/** English Gregorian month names and their common abbreviations. */
export const GREGORIAN_MONTH_NAMES: GregorianMonthName[] = [
  { month: 1, names: ['january', 'jan'] },
  { month: 2, names: ['february', 'feb'] },
  { month: 3, names: ['march', 'mar'] },
  { month: 4, names: ['april', 'apr'] },
  { month: 5, names: ['may'] },
  { month: 6, names: ['june', 'jun'] },
  { month: 7, names: ['july', 'jul'] },
  { month: 8, names: ['august', 'aug'] },
  { month: 9, names: ['september', 'sept', 'sep'] },
  { month: 10, names: ['october', 'oct'] },
  { month: 11, names: ['november', 'nov'] },
  { month: 12, names: ['december', 'dec'] },
];

const MONTH_ALTERNATION = GREGORIAN_MONTH_NAMES.flatMap((entry) => entry.names).join('|');

// Job-posted dates are modern. A floor of year 1000 keeps two-digit input from
// being silently reinterpreted (`Date.UTC(25, ...)` maps to 1925).
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;

const HIGH_CONFIDENCE: Probability = asProbability(0.95);
const RELATIVE_CONFIDENCE: Probability = asProbability(0.6);
const NO_CONFIDENCE: Probability = asProbability(0);

export interface GregorianParseInput {
  text: string | null | undefined;
  /**
   * Declared source calendar. ETHIOPIAN is declined here — those dates belong to
   * the Ethiopian parser (see `parseDate`).
   */
  sourceCalendarHint?: CalendarType | null;
  /** Declared numeric date format; required for numeric-only dates. */
  declaredDateFormat?: DeclaredDateFormat | null;
  /** Date the item was collected, used only to resolve relative dates. */
  collectedAt?: Date | null;
}

function unknownDate(originalText: string | null): DateParsed {
  return {
    calendar: CalendarType.UNKNOWN,
    publishedAt: null,
    originalText,
    confidence: NO_CONFIDENCE,
    conversionMethod: null,
  };
}

/** Report a recognized-Gregorian input whose date is invalid: no `publishedAt`. */
function gregorianDate(
  publishedAt: Date | null,
  originalText: string,
  conversionMethod: string,
  confidence: Probability,
): DateParsed {
  return {
    calendar: CalendarType.GREGORIAN,
    publishedAt,
    originalText,
    confidence,
    conversionMethod,
  };
}

function monthFromName(name: string): number | null {
  const lower = name.toLowerCase();
  for (const entry of GREGORIAN_MONTH_NAMES) {
    if (entry.names.includes(lower)) return entry.month;
  }
  return null;
}

/** Build a UTC-midnight date, rejecting calendar-impossible days (e.g. Feb 30). */
function dateOnlyUtc(year: number, month: number, day: number): Date | null {
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function tryIso8601(originalText: string, lower: string): DateParsed | null {
  // Trailing (?!\d) (not \b) so a full ISO timestamp `2025-09-15T10:30Z` still
  // exposes its date part: `5` and `T` are both word characters, so \b fails.
  const match = lower.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null; // not a date shape
  return gregorianDate(dateOnlyUtc(year, month, day), originalText, GREGORIAN_ISO_VERSION, HIGH_CONFIDENCE);
}

const DAY_FIRST = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALTERNATION})\\b\\.?,?\\s*(\\d{4})\\b`,
  'i',
);
const MONTH_FIRST = new RegExp(
  `\\b(${MONTH_ALTERNATION})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})\\b`,
  'i',
);

function tryNamedMonth(originalText: string): DateParsed | null {
  const dayFirst = DAY_FIRST.exec(originalText);
  if (dayFirst) {
    const month = monthFromName(dayFirst[2]);
    if (month !== null) {
      const day = parseInt(dayFirst[1], 10);
      const year = parseInt(dayFirst[3], 10);
      return gregorianDate(dateOnlyUtc(year, month, day), originalText, GREGORIAN_NAMED_MONTH_VERSION, HIGH_CONFIDENCE);
    }
  }

  const monthFirst = MONTH_FIRST.exec(originalText);
  if (monthFirst) {
    const month = monthFromName(monthFirst[1]);
    if (month !== null) {
      const day = parseInt(monthFirst[2], 10);
      const year = parseInt(monthFirst[3], 10);
      return gregorianDate(dateOnlyUtc(year, month, day), originalText, GREGORIAN_NAMED_MONTH_VERSION, HIGH_CONFIDENCE);
    }
  }

  return null;
}

const RELATIVE_AGO = /\b(\d{1,4})\s*(hour|hours|day|days|week|weeks|month|months|year|years)\s+ago\b/;
const RELATIVE_TODAY = /\btoday\b/;
const RELATIVE_YESTERDAY = /\byesterday\b/;

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function shiftUtcMonths(base: Date, months: number): void {
  const day = base.getUTCDate();
  base.setUTCDate(1);
  base.setUTCMonth(base.getUTCMonth() - months);
  base.setUTCDate(Math.min(day, daysInUtcMonth(base.getUTCFullYear(), base.getUTCMonth())));
}

function tryRelative(originalText: string, collectedAt: Date | null): DateParsed | null {
  const lower = originalText.toLowerCase();
  const ago = RELATIVE_AGO.exec(lower);
  const today = RELATIVE_TODAY.test(lower);
  const yesterday = RELATIVE_YESTERDAY.test(lower);
  if (!ago && !today && !yesterday) return null;

  // Without an injected collection time a relative date cannot be resolved and
  // must not be guessed (ENG-012).
  if (!collectedAt) return unknownDate(originalText);

  const base = new Date(collectedAt.getTime());
  if (ago) {
    const amount = parseInt(ago[1], 10);
    switch (ago[2].replace(/s$/, '')) {
      case 'hour':
        base.setUTCHours(base.getUTCHours() - amount);
        break;
      case 'day':
        base.setUTCDate(base.getUTCDate() - amount);
        break;
      case 'week':
        base.setUTCDate(base.getUTCDate() - amount * 7);
        break;
      case 'month':
        shiftUtcMonths(base, amount);
        break;
      case 'year':
        shiftUtcMonths(base, amount * 12);
        break;
    }
  } else if (yesterday) {
    base.setUTCDate(base.getUTCDate() - 1);
  }

  const publishedAt = dateOnlyUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
  return gregorianDate(publishedAt, originalText, GREGORIAN_RELATIVE_VERSION, RELATIVE_CONFIDENCE);
}

const FORMAT_TOKEN = /(YYYY|MM|DD)/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile a declared format such as `DD/MM/YYYY` into an anchored matcher. */
function declaredFormatToRegExp(format: DeclaredDateFormat): RegExp {
  const source = format
    .split(FORMAT_TOKEN)
    .filter((part) => part !== '')
    .map((part) => {
      if (part === 'YYYY') return '(\\d{4})';
      if (part === 'MM') return '(\\d{1,2})';
      if (part === 'DD') return '(\\d{1,2})';
      return escapeRegExp(part);
    })
    .join('');
  return new RegExp(`\\b${source}(?!\\d)`);
}

function tryDeclaredFormat(
  lower: string,
  originalText: string,
  format: DeclaredDateFormat | null,
  calendarHint: CalendarType | null,
): DateParsed | null {
  // Both declarations are required: the format resolves day/month order, the
  // calendar resolves Gregorian vs Ethiopian (SRS Appendix E).
  if (format === null || calendarHint !== CalendarType.GREGORIAN) return null;

  const match = declaredFormatToRegExp(format).exec(lower);
  if (!match) return null;

  const order = format.match(FORMAT_TOKEN) ?? [];
  const values: Record<string, number> = {};
  order.forEach((token, index) => {
    values[token] = parseInt(match[index + 1], 10);
  });

  return gregorianDate(
    dateOnlyUtc(values.YYYY, values.MM, values.DD),
    originalText,
    GREGORIAN_DECLARED_FORMAT_VERSION,
    HIGH_CONFIDENCE,
  );
}

/**
 * Parse one date field into a Gregorian date-only value. Never throws; anything
 * not backed by an explicit signal stays UNKNOWN (ENG-001).
 */
export function parseGregorianDate(input: GregorianParseInput): DateParsed {
  if (input.text === null || input.text === undefined) return unknownDate(null);
  const originalText = input.text.trim();
  if (!originalText) return unknownDate(null);

  // Never silently reinterpret a source's declared Ethiopian dates as Gregorian.
  if (input.sourceCalendarHint === CalendarType.ETHIOPIAN) return unknownDate(originalText);

  const lower = originalText.toLowerCase();

  return (
    tryIso8601(originalText, lower) ??
    tryNamedMonth(originalText) ??
    tryRelative(originalText, input.collectedAt ?? null) ??
    tryDeclaredFormat(lower, originalText, input.declaredDateFormat ?? null, input.sourceCalendarHint ?? null) ??
    unknownDate(originalText)
  );
}
