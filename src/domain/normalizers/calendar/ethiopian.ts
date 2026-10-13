import { CalendarType } from '@domain/enums';
import { DateParsed } from '@domain/types';

export interface EthiopianMonthName {
  month: number;
  amharic: string[];
  latin: string[];
}

// Ethiopian (Amete Mihret) month names mapped to their 1-based month number.
// Named variants are aliases, not separate months. Extend only when a real
// fixture requires it.
export const ETHIOPIAN_MONTH_NAMES: EthiopianMonthName[] = [
  { month: 1, amharic: ['መስከረም'], latin: ['meskerem'] },
  { month: 2, amharic: ['ጥቅምት'], latin: ['tikimt', 'tikemt'] },
  { month: 3, amharic: ['ኅዳር'], latin: ['hidar', 'hedar'] },
  { month: 4, amharic: ['ታኅሣሥ'], latin: ['tahsas'] },
  { month: 5, amharic: ['ጥር'], latin: ['tir'] },
  { month: 6, amharic: ['የካቲት'], latin: ['yekatit'] },
  { month: 7, amharic: ['መጋቢት'], latin: ['megabit'] },
  { month: 8, amharic: ['ሚያዝያ'], latin: ['miyazya', 'miazia'] },
  { month: 9, amharic: ['ግንቦት'], latin: ['ginbot'] },
  { month: 10, amharic: ['ሰኔ'], latin: ['sene'] },
  { month: 11, amharic: ['ሐምሌ'], latin: ['hamle'] },
  { month: 12, amharic: ['ነሐሴ'], latin: ['nehase'] },
  { month: 13, amharic: ['ጳጉሜ'], latin: ['pagume'] },
];

export const ETHIOPIAN_CALENDAR_VERSION = 'ETHIOPIAN_CALENDAR_V1';

// Amete Mihret (Amete Alem 5500 offset) JDN epoch.
const START_JDN = 1723856;

export interface EthiopianDate {
  year: number;
  month: number;
  day: number;
}

export function isLeapEthiopian(year: number): boolean {
  return year % 4 === 3;
}

export function ethiopianToJdn(year: number, month: number, day: number): number {
  return START_JDN + 365 * year + Math.floor(year / 4) + 30 * month + day - 31;
}

export function jdnToEthiopian(jdn: number): EthiopianDate {
  const r = ((jdn - START_JDN) % 1461 + 1461) % 1461;
  const n = (r % 365) + 365 * Math.floor(r / 1460);
  const year = 4 * Math.floor((jdn - START_JDN) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460);
  const month = Math.floor(n / 30) + 1;
  const day = (n % 30) + 1;
  return { year, month, day };
}

export function jdnToGregorianDateOnly(jdn: number): string {
  const ms = (jdn - 2440588) * 86400000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

export function gregorianToJdnUTC(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d) / 86400000 + 2440588;
}

export interface EthiopianParseInput {
  text: string | null | undefined;
  sourceCalendarHint?: CalendarType | null;
  collectedAt?: Date | null;
  injectedClock?: Date | null;
}

function unknownResult(originalText: string | null): DateParsed {
  return {
    calendar: CalendarType.UNKNOWN,
    publishedAt: null,
    originalText,
    confidence: 0,
    conversionMethod: null,
  };
}

function invalidEthiopian(originalText: string): DateParsed {
  return {
    calendar: CalendarType.ETHIOPIAN,
    publishedAt: null,
    originalText,
    confidence: 0,
    conversionMethod: ETHIOPIAN_CALENDAR_VERSION,
  };
}

function hasAmharicMonthName(text: string): boolean {
  return ETHIOPIAN_MONTH_NAMES.some((entry) => entry.amharic.some((m) => text.includes(m)));
}

function hasLatinMonthName(lower: string): boolean {
  return ETHIOPIAN_MONTH_NAMES.some((entry) =>
    entry.latin.some((m) => new RegExp(`\\b${m}\\b`).test(lower)),
  );
}

function monthFromText(text: string, lower: string): number | null {
  for (const entry of ETHIOPIAN_MONTH_NAMES) {
    for (const amharic of entry.amharic) {
      if (text.includes(amharic)) return entry.month;
    }
  }
  for (const entry of ETHIOPIAN_MONTH_NAMES) {
    for (const latin of entry.latin) {
      if (new RegExp(`\\b${latin}\\b`).test(lower)) return entry.month;
    }
  }
  return null;
}

/**
 * Deterministically convert an Ethiopian-calendar date string to Gregorian.
 * Only explicit signals (month name, era marker, source hint) qualify; anything
 * else returns UNKNOWN. Invalid dates return UNKNOWN. Never throws.
 */
export function parseEthiopianDate(input: EthiopianParseInput): DateParsed {
  if (input.text === null || input.text === undefined) return unknownResult(null);
  const originalText = input.text.trim();
  if (!originalText) return unknownResult(null);

  const lower = originalText.toLowerCase();
  const hasEraMarker = /(?:^|\b)e\.?c\.?\b|ዓ\.ም|ዓም/i.test(lower);
  const hasAmharicMonth = hasAmharicMonthName(originalText);
  const hasLatinMonth = hasLatinMonthName(lower);
  const hasSourceHint = input.sourceCalendarHint === CalendarType.ETHIOPIAN;
  const hasExplicit = hasEraMarker || hasAmharicMonth || hasLatinMonth || hasSourceHint;

  if (!hasExplicit) return unknownResult(originalText);

  const matched = originalText.match(/\d+/g);
  const numbers: string[] = matched ?? [];
  const monthFromName = monthFromText(originalText, lower);

  let day: number;
  let month: number;
  let year: number;
  if (monthFromName !== null) {
    // Named month: the numbers are [day, year].
    if (numbers.length < 2) return unknownResult(originalText);
    day = parseInt(numbers[0], 10);
    year = parseInt(numbers[1], 10);
    month = monthFromName;
  } else {
    // No named month: require [day, month, year].
    if (numbers.length < 3) return unknownResult(originalText);
    day = parseInt(numbers[0], 10);
    month = parseInt(numbers[1], 10);
    year = parseInt(numbers[2], 10);
  }

  if (month < 1 || month > 13) return invalidEthiopian(originalText);
  if (day < 1) return invalidEthiopian(originalText);
  if (year < 1) return invalidEthiopian(originalText);

  if (month === 13) {
    const maxPagume = isLeapEthiopian(year) ? 6 : 5;
    if (day > maxPagume) return invalidEthiopian(originalText);
  } else if (day > 30) {
    return invalidEthiopian(originalText);
  }

  const jdn = ethiopianToJdn(year, month, day);
  const greg = jdnToGregorianDateOnly(jdn);
  const [gy, gm, gd] = greg.split('-').map((p) => parseInt(p, 10));
  const publishedAt = new Date(Date.UTC(gy, gm - 1, gd));

  return {
    calendar: CalendarType.ETHIOPIAN,
    publishedAt,
    originalText,
    confidence: 0.9,
    conversionMethod: ETHIOPIAN_CALENDAR_VERSION,
  };
}
