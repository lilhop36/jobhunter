import { SalaryType, SalaryPeriod } from '../enums';

export interface SalaryParsed {
  type: SalaryType;
  min: number | null;
  max: number | null;
  currency: string | null;
  period: SalaryPeriod | null;
  evidence: string | null;
  confidence: number; // 0..1 extraction confidence (SRS B.1)
}
