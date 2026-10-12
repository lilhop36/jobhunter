import { CalendarType, SalaryPeriod, SalaryType } from '../enums';
import { DateParsed, SalaryParsed } from '../types';

export function parseSalary(text: string | null | undefined): SalaryParsed {
  if (!text) {
    return {
      type: SalaryType.UNKNOWN,
      min: null,
      max: null,
      currency: null,
      period: SalaryPeriod.UNKNOWN,
      evidence: null,
      confidence: 0,
    };
  }
  const raw = text.trim();
  if (!raw) {
    return {
      type: SalaryType.UNKNOWN,
      min: null,
      max: null,
      currency: null,
      period: SalaryPeriod.UNKNOWN,
      evidence: null,
      confidence: 0,
    };
  }
  const lower = raw.toLowerCase();
  if (/negotiable|negotiat/.test(lower)) {
    return { type: SalaryType.NEGOTIABLE, min: null, max: null, currency: null, period: SalaryPeriod.UNKNOWN, evidence: raw, confidence: 90 };
  }
  if (/as per scale|as per pay scale|scale/.test(lower)) {
    return { type: SalaryType.AS_PER_SCALE, min: null, max: null, currency: null, period: SalaryPeriod.UNKNOWN, evidence: raw, confidence: 90 };
  }
  if (/not disclosed|undisclosed|confidential/.test(lower)) {
    return { type: SalaryType.NOT_DISCLOSED, min: null, max: null, currency: null, period: SalaryPeriod.UNKNOWN, evidence: raw, confidence: 90 };
  }
  if (/unknown/.test(lower)) {
    return { type: SalaryType.UNKNOWN, min: null, max: null, currency: null, period: SalaryPeriod.UNKNOWN, evidence: raw, confidence: 0 };
  }
  // TODO: numeric extraction; keep conservative for now
  return { type: SalaryType.UNKNOWN, min: null, max: null, currency: null, period: SalaryPeriod.UNKNOWN, evidence: raw, confidence: 0 };
}
