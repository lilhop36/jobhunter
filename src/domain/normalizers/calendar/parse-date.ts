import { CalendarType } from '@domain/enums';
import { DateParsed, DeclaredDateFormat } from '@domain/types';
import { hasEthiopianTextSignal, parseEthiopianDate } from './ethiopian';
import { parseGregorianDate } from './gregorian';

export interface DateParseInput {
  text: string | null | undefined;
  /** Declared source calendar, used only as an explicit signal (Appendix E). */
  sourceCalendarHint?: CalendarType | null;
  /** Declared numeric date format, used only with a declared calendar. */
  declaredDateFormat?: DeclaredDateFormat | null;
  /** Collection time, used only to resolve relative dates. */
  collectedAt?: Date | null;
}

/**
 * Canonical date entry point for adapters (ENG-016).
 *
 * Routes to the Ethiopian parser when the text carries an explicit
 * Ethiopian-calendar signal or the source declares that calendar; otherwise to
 * the Gregorian parser. Both delegate decisions to explicit signals only, so an
 * ambiguous input stays UNKNOWN (SRS Appendix E).
 */
export function parseDate(input: DateParseInput): DateParsed {
  const ethiopian = hasEthiopianTextSignal(input.text) || input.sourceCalendarHint === CalendarType.ETHIOPIAN;
  if (ethiopian) {
    return parseEthiopianDate({
      text: input.text,
      sourceCalendarHint: input.sourceCalendarHint,
      collectedAt: input.collectedAt,
    });
  }
  return parseGregorianDate({
    text: input.text,
    sourceCalendarHint: input.sourceCalendarHint,
    declaredDateFormat: input.declaredDateFormat,
    collectedAt: input.collectedAt,
  });
}
