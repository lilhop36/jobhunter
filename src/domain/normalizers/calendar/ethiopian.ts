import { CalendarType } from '@domain/enums';
import { DateParsed } from '@domain/types';

const ETHIOPIAN_MONTHS = [
  'meskerem', 'tikimt', 'tikemt', 'hidar', 'hedar', 'tahsas', 'tir', 'yekatit', 'megabit', 'miyazya', 'miazia', 'ginbot', 'sene', 'hamle', 'nehase', 'pagume',
];

const ETHIOPIAN_MONTHS_AMHARIC = [
  'መስከረም', 'ጥቅምት', 'ኅዳር', 'ታኅሣሥ', 'ጥር', 'የካቲት', 'መጋቢት', 'ሚያዝያ', 'ግንቦት', 'ሰኔ', 'ሐምሌ', 'ነሐሴ', 'ጳጉሜ',
];

const START_JDN = 1723856;

function isLeapEthiopian(year: number): boolean {
  return year % 4 === 3;
}

function ethiopianToJdn(year: number, month: number, day: number): number {
  return START_JDN + 365 * year + Math.floor(year / 4) + 30 * month + day - 31;
}

function jdnToGregorianDateOnly(jdn: number): string {
  const ms = (jdn - 2440588) * 86400000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return ${y.toString().padStart(4, '0')}--;
}

export interface EthiopianParseInput {
  text: string | null | undefined;
  sourceCalendarHint?: CalendarType | null;
  collectedAt?: Date | null;
  injectedClock?: Date | null;
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
  const num = originalText.match(/\d+/g);
  if (!num || num.length < 3) {
    return { calendar: CalendarType.ETHIOPIAN, publishedAt: null, originalText, confidence: 20, conversionMethod: 'ETHIOPIAN_CALENDAR_V1' };
  }
  let day = parseInt(num[0]);
  let month = parseInt(num[1]);
  let year = parseInt(num[2]);
  for (let i = 0; i < ETHIOPIAN_MONTHS.length; i++) {
    if (new RegExp(\\b\\b).test(lower)) {
      month = i + 1;
      break;
    }
  }
  for (let i = 0; i < ETHIOPIAN_MONTHS_AMHARIC.length; i++) {
    if (originalText.includes(ETHIOPIAN_MONTHS_AMHARIC[i])) {
      month = i + 1;
      break;
    }
  }
  if (month < 1 || month > 13) {
    return { calendar: CalendarType.ETHIOPIAN, publishedAt: null, originalText, confidence: 0, conversionMethod: 'ETHIOPIAN_CALENDAR_V1' };
  }
  if (day < 1) {
    return { calendar: CalendarType.ETHIOPIAN, publishedAt: null, originalText, confidence: 0, conversionMethod: 'ETHIOPIAN_CALENDAR_V1' };
  }
  if (month === 13) {
    const maxPagume = isLeapEthiopian(year) ? 6 : 5;
    if (day > maxPagume) {
      return { calendar: CalendarType.ETHIOPIAN, publishedAt: null, originalText, confidence: 0, conversionMethod: 'ETHIOPIAN_CALENDAR_V1' };
    }
  } else {
    if (day > 30) {
      return { calendar: CalendarType.ETHIOPIAN, publishedAt: null, originalText, confidence: 0, conversionMethod: 'ETHIOPIAN_CALENDAR_V1' };
    }
  }
  try {
    const jdn = ethiopianToJdn(year, month, day);
    const greg = jdnToGregorianDateOnly(jdn);
    const parts = greg.split('-');
    const gy = parseInt(parts[0]);
    const gm = parseInt(parts[1]);
    const gd = parseInt(parts[2]);
    const pub = new Date(Date.UTC(gy, gm - 1, gd));
    return { calendar: CalendarType.ETHIOPIAN, publishedAt: pub, originalText, confidence: 90, conversionMethod: 'ETHIOPIAN_CALENDAR_V1' };
  } catch {
    return { calendar: CalendarType.ETHIOPIAN, publishedAt: null, originalText, confidence: 0, conversionMethod: 'ETHIOPIAN_CALENDAR_V1' };
  }
}
