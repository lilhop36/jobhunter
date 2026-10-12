import { CalendarType } from '@domain/enums';
import { DateParsed } from '@domain/types';

export interface EthiopianParseInput {
  text: string | null | undefined;
  sourceCalendarHint?: CalendarType | null;
}

const ETHIOPIAN_MONTHS = [
  'meskerem', 'tikimt', 'hidar', 'tahsas', 'tir', 'yekatit', 'megabit', 'miyazya', 'ginbot', 'sene', 'hamle', 'nehase', 'pagume',
];

export function parseEthiopianDate(input: EthiopianParseInput): DateParsed {
  if (!input.text) {
    return {
      calendar: CalendarType.UNKNOWN,
      publishedAt: null,
      originalText: null,
      confidence: 0,
      conversionMethod: null,
    };
  }
  const originalText = input.text.trim();
  if (!originalText) {
    return {
      calendar: CalendarType.UNKNOWN,
      publishedAt: null,
      originalText: null,
      confidence: 0,
      conversionMethod: null,
    };
  }
  const lower = originalText.toLowerCase();
  // Explicit signals only
  const hasEc = /e\.c\.|ec\.|ዓ\.ም|ዓም/.test(lower);
  const hasAmharic = /መስከረም|ጥቅምት|ኅዳር|ታኅሣሥ|ጥር|የካቲት|መጋቢት|ሚያዝያ|ግንቦት|ሰኔ|ሐምሌ|ነሐሴ|ጳጉሜ/.test(lower);
  const hasMonthName = ETHIOPIAN_MONTHS.some(m => new RegExp(\\b\\b).test(lower));
  const hasExplicit = hasEc || hasAmharic || hasMonthName;
  if (!hasExplicit) {
    return {
      calendar: CalendarType.UNKNOWN,
      publishedAt: null,
      originalText,
      confidence: 0,
      conversionMethod: null,
    };
  }
  // TODO: implement full conversion with validation
  return {
    calendar: CalendarType.ETHIOPIAN,
    publishedAt: null,
    originalText,
    confidence: 30,
    conversionMethod: 'ETHIOPIAN_CALENDAR_V1',
  };
}
