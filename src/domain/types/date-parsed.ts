import { CalendarType } from '../enums';
import { Probability } from './numeric-units';

export interface DateParsed {
  calendar: CalendarType;
  publishedAt: Date | null;
  originalText: string | null;
  /** Per-field extraction confidence in [0, 1] (SRS B.2). Not a match score. */
  confidence: Probability;
  conversionMethod: string | null; // e.g. 'ETHIOPIAN_CALENDAR_V1' when ETHIOPIAN
}
