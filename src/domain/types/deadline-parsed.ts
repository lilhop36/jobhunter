/**
 * A deadline read from source text (FR-019).
 *
 * `deadlineAt` is date-only (UTC midnight), the same contract as a parsed publication date.
 * `null` means UNKNOWN — the source stated no deadline this system could read — and is never a
 * claim that the posting never closes.
 */
export interface DeadlineParsed {
  deadlineAt: Date | null;
  /** The labelled phrase the date came from, for provenance; null when nothing parsed. */
  evidence: string | null;
  /** The date rule that produced the value (ENG-003), or null when nothing parsed. */
  conversionMethod: string | null;
}
