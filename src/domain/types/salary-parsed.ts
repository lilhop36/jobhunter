import { SalaryType, SalaryPeriod } from '../enums';
import { DecimalAmount } from './decimal-amount';
import { Probability } from './numeric-units';

export interface SalaryParsed {
  type: SalaryType;
  /** Exact monetary amounts (SRS ENG-006); null when unknown or not applicable. */
  min: DecimalAmount | null;
  max: DecimalAmount | null;
  currency: string | null;
  period: SalaryPeriod | null;
  evidence: string | null;
  /** Per-field extraction confidence in [0, 1] (SRS B.1). Not a match score. */
  confidence: Probability;
}
