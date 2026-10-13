import { CalendarType } from '../enums';

export interface DateParsed {
  calendar: CalendarType;
  publishedAt: Date | null;
  originalText: string | null;
  confidence: number; // 0..1 (SRS B.2)
  conversionMethod: string | null; // e.g. 'ETHIOPIAN_CALENDAR_V1' when ETHIOPIAN
}
