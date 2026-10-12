import { CalendarType } from '@domain/enums';
import { DateParsed } from '@domain/types';

export interface EthiopianParseInput {
  text: string | null | undefined;
  sourceCalendarHint?: CalendarType | null;
  collectedAt?: Date | null;
  injectedClock?: Date | null;
}

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
