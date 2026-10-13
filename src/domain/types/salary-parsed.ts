import { SalaryType, SalaryPeriod } from '../enums';
import { Probability } from './numeric-units';

export interface SalaryParsed {
  type: SalaryType;
  min: number | null;
  max: number | null;
  currency: string | null;
  period: SalaryPeriod | null;
  evidence: string | null;
  /** Per-field extraction confidence in [0, 1] (SRS B.1). Not a match score. */
  confidence: Probability;
}
