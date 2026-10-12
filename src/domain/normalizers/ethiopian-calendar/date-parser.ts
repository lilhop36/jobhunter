import { CalendarType } from '@domain/enums';
import { DateParsed } from '@domain/types';

export interface EthiopianParseInput {
  text: string | null | undefined;
  sourceCalendarHint?: CalendarType | null;
  collectedAt?: Date | null;
}

const ETHIOPIAN_MONTHS = [
  'meskerem', 'tikimt', 'tikemt', 'hidar', 'hedar', 'tahsas', 'tir', 'yekatit', 'megabit', 'miyazya', 'miazia', 'ginbot', 'sene', 'hamle', 'nehase', 'pagume',
];

const ETHIOPIAN_MONTHS_AMHARIC = [
  'መስከረም', 'ጥቅምት', 'ኅዳር', 'ታኅሣሥ', 'ጥር', 'የካቲት', 'መጋቢት', 'ሚያዝያ', 'ግንቦት', 'ሰኔ', 'ሐምሌ', 'ነሐሴ', 'ጳጉሜ',
];

function isLeapEthiopian(year: number): boolean {
  return year % 4 === 3;
}

function jdnToEthiopian(jdn: number): { year: number; month: number; day: number } {
  const start = 1723856; // Amete Mihret epoch
  const r = ((jdn - start) % 1461 + 1461) % 1461; // non-negative
  const n = (r % 365) + 365 * Math.floor(r / 1460);
  const year = 4 * Math.floor((jdn - start) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460);
  const month = Math.floor(n / 30) + 1;
  const day = (n % 30) + 1;
  return { year, month, day };
}

function ethiopianToJdn(year: number, month: number, day: number): number {
  const start = 1723856;
  return start + 365 * year + Math.floor(year / 4) + 30 * month + day - 31;
}

function jdnToGregorianDateOnly(jdn: number): string {
  const ms = (jdn - 2440588) * 86400000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return ${y.toString().padStart(4, '0')}--;
}

export function parseEthiopianDate(input: EthiopianParseInput): DateParsed {
  if (!input.text) {
    return { calendar: CalendarType.UNKNOWN, publishedAt: null, originalText: null, confidence: 0, conversionMethod: null };
  }
  const originalText = input.text.trim();
  if (!originalText) {
    return { calendar: CalendarType.UNKNOWN, publishedAt: null, originalText: null, confidence: 0, conversionMethod: null };
  }
  const lower = originalText.toLowerCase();
  const hasEc = /e\.c\.|ec\.|ዓ\.ም|ዓም/.test(lower);
  const hasAmharic = ETHIOPIAN_MONTHS_AMHARIC.some(m => originalText.includes(m));
  const hasMonthName = ETHIOPIAN_MONTHS.some(m => new RegExp(\\b\\b).test(lower));
  const hasExplicit = hasEc || hasAmharic || hasMonthName;
  if (!hasExplicit) {
    return { calendar: CalendarType.UNKNOWN, publishedAt: null, originalText, confidence: 0, conversionMethod: null };
  }
  // TODO: extract numbers and convert
  return { calendar: CalendarType.ETHIOPIAN, publishedAt: null, originalText, confidence: 30, conversionMethod: 'ETHIOPIAN_CALENDAR_V1' };
}
