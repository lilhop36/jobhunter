import { SalaryPeriod, SalaryType } from '../enums';
import {
  asProbability,
  compareDecimalAmount,
  DecimalAmount,
  isDecimalAmount,
  Probability,
  SalaryParsed,
} from '../types';

// Currency recognition. Codes are validated strings; we never invent an amount.
const CURRENCY_ALIASES: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /(?:^|\b)etb\b|birr|(?:^|\s)br(?:$|\s)|\u1265\u122d/i, code: 'ETB' },
  { pattern: /\busd\b|us\$|\$|\u0024/i, code: 'USD' },
  { pattern: /(?:^|\b)eur\b|\u20ac/i, code: 'EUR' },
  { pattern: /(?:^|\b)gbp\b|\u00a3/i, code: 'GBP' },
  { pattern: /(?:^|\b)kes\b/i, code: 'KES' },
  { pattern: /(?:^|\b)aed\b/i, code: 'AED' },
];

// "salary" in English and Amharic (ደመወዝ).
const SALARY_KEYWORDS = /\bsalary\b|\bwage\b|\bpay\b|compensation|remuneration|stipend|\u12f0\u1218\u12c8\u12d8/i;

function detectCurrency(lower: string): string | null {
  for (const alias of CURRENCY_ALIASES) {
    if (alias.pattern.test(lower)) return alias.code;
  }
  return null;
}

const PERIOD_PATTERNS: Array<{ pattern: RegExp; period: SalaryPeriod }> = [
  { pattern: /per\s+month|monthly|\/\s*month|p\.?m\.?\b/i, period: SalaryPeriod.MONTH },
  { pattern: /per\s+annum|per\s+year|yearly|annually|\/\s*year|p\.?a\.?\b/i, period: SalaryPeriod.YEAR },
  { pattern: /per\s+hour|hourly|\/\s*hour|p\.?h\.?\b/i, period: SalaryPeriod.HOUR },
  { pattern: /per\s+day|daily|\/\s*day|p\.?d\.?\b/i, period: SalaryPeriod.DAY },
  { pattern: /per\s+week|weekly|\/\s*week|p\.?w\.?\b/i, period: SalaryPeriod.WEEK },
];

function detectPeriod(lower: string): SalaryPeriod {
  for (const entry of PERIOD_PATTERNS) {
    if (entry.pattern.test(lower)) return entry.period;
  }
  return SalaryPeriod.UNKNOWN;
}

/** Move a decimal point `places` digits to the right as an exact string operation. */
function shiftDecimalRight(value: string, places: number): string {
  const [integer, fraction = ''] = value.split('.');
  const digits = integer + fraction;
  const point = integer.length + places;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Canonicalize a matched numeric token into an exact `DecimalAmount` (ENG-006),
 * never a binary float. Returns null for tokens the canonical `DECIMAL(14,2)`
 * storage cannot represent — notably more than two fractional digits, which are
 * rejected rather than silently rounded.
 */
function normalizeAmount(token: string): DecimalAmount | null {
  let cleaned = token.replace(/[,\s]/g, '').toLowerCase();
  if (cleaned.endsWith('k')) cleaned = shiftDecimalRight(cleaned.slice(0, -1), 3);

  const [integer, fraction = ''] = cleaned.split('.');
  if (!/^\d+$/.test(integer)) return null;
  if (fraction && !/^\d{1,2}$/.test(fraction)) return null;
  const canonical = fraction ? `${integer.replace(/^0+(?=\d)/, '')}.${fraction}` : integer.replace(/^0+(?=\d)/, '');
  return isDecimalAmount(canonical) ? canonical : null;
}

function extractAmounts(lower: string): DecimalAmount[] {
  const matches = lower.match(/\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?k?|\d+(?:\.\d+)?k?/gi);
  if (!matches) return [];
  const out: DecimalAmount[] = [];
  for (const m of matches) {
    const value = normalizeAmount(m);
    if (value !== null) out.push(value);
  }
  return out;
}

function unknown(raw: string | null): SalaryParsed {
  return {
    type: SalaryType.UNKNOWN,
    min: null,
    max: null,
    currency: null,
    period: SalaryPeriod.UNKNOWN,
    evidence: raw,
    confidence: asProbability(0),
  };
}

function nonNumeric(type: SalaryType, raw: string, confidence: Probability): SalaryParsed {
  return {
    type,
    min: null,
    max: null,
    currency: null,
    period: SalaryPeriod.UNKNOWN,
    evidence: raw,
    confidence,
  };
}

// Range separators: hyphen, en dash (U+2013), em dash (U+2014), or the word "to".
function hasRangeSeparator(lower: string): boolean {
  return /[-\u2013\u2014]|\bto\b/.test(lower);
}

export function parseSalary(text: string | null | undefined): SalaryParsed {
  if (text === null || text === undefined) return unknown(null);
  const raw = text.trim();
  if (!raw) return unknown(null);

  const lower = raw.toLowerCase();
  const currency = detectCurrency(lower);
  const period = detectPeriod(lower);
  const hasKeyword = SALARY_KEYWORDS.test(lower);
  const amounts = extractAmounts(lower);
  const hasAmountContext = currency !== null || hasKeyword;
  const negotiable = /negotia/i.test(lower);

  // Numeric extraction only when a currency token or salary keyword is present,
  // so plain years (2018) and phone numbers never become salaries.
  if (amounts.length > 0 && hasAmountContext) {
    if (amounts.length >= 2 && hasRangeSeparator(lower)) {
      const min = amounts[0];
      const max = amounts[1];
      if (compareDecimalAmount(min, max) > 0) return unknown(raw); // conflicting; never silently swap
      return {
        type: SalaryType.RANGE,
        min,
        max,
        currency,
        period,
        evidence: raw,
        confidence: asProbability(negotiable ? 0.6 : 0.9),
      };
    }

    const value = amounts[0];
    let type: SalaryType = SalaryType.EXACT;
    if (/starting|from|minimum|\bmin\b/i.test(lower)) type = SalaryType.STARTING_FROM;
    else if (/up\s*to|maximum|\bmax\b/i.test(lower)) type = SalaryType.UP_TO;

    const min = type === SalaryType.UP_TO ? null : value;
    const max = type === SalaryType.STARTING_FROM ? null : value;
    return {
      type,
      min,
      max,
      currency,
      period,
      evidence: raw,
      confidence: asProbability(negotiable ? 0.6 : 0.9),
    };
  }

  // No concrete amount: represent the non-numeric salary states (AC-007).
  if (negotiable) return nonNumeric(SalaryType.NEGOTIABLE, raw, asProbability(0.9));
  if (/as\s+per\s+scale|scale/i.test(lower)) return nonNumeric(SalaryType.AS_PER_SCALE, raw, asProbability(0.9));
  if (/not\s+disclosed|undisclosed|confidential|not\s+specified/i.test(lower)) {
    return nonNumeric(SalaryType.NOT_DISCLOSED, raw, asProbability(0.9));
  }
  return unknown(raw);
}
