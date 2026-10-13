import { CalendarType } from '../enums';
import { Probability } from './numeric-units';

/**
 * Explicitly declared numeric date format for a source (SRS Appendix E).
 *
 * Only meaningful together with a declared calendar: a numeric-only date such
 * as `05/01/2025` is ambiguous (day/month order *and* calendar), so JobHunter
 * keeps it UNKNOWN unless the adapter declares both. Unambiguous forms (ISO
 * 8601, or a month name) never need this.
 */
export type DeclaredDateFormat =
  | 'YYYY-MM-DD'
  | 'DD/MM/YYYY'
  | 'MM/DD/YYYY'
  | 'DD-MM-YYYY'
  | 'MM-DD-YYYY'
  | 'DD.MM.YYYY'
  | 'MM.DD.YYYY';

export interface DateParsed {
  calendar: CalendarType;
  publishedAt: Date | null;
  originalText: string | null;
  /** Per-field extraction confidence in [0, 1] (SRS B.2). Not a match score. */
  confidence: Probability;
  conversionMethod: string | null; // e.g. 'ETHIOPIAN_CALENDAR_V1' when ETHIOPIAN
}
