import { ProvenanceSource } from '../enums';

/**
 * The Job fields whose origin must stay distinguishable (SRS ENG-003,
 * Appendix E). Names match the canonical `Job` attributes so the map persists
 * verbatim as the `jobs.provenance` JSON column.
 */
export const JOB_PROVENANCE_FIELDS = [
  'canonicalUrl',
  'title',
  'company',
  'description',
  'descriptionQuality',
  'locationText',
  'locationCategory',
  'remoteStatus',
  'publishedCalendar',
  'originalPublishedDateText',
  'publishedAt',
  'salaryType',
  'salaryMin',
  'salaryMax',
  'salaryCurrency',
  'salaryPeriod',
  'employmentType',
  'applicationMethod',
  'applyUrl',
  'applyEmail',
  'contentFingerprint',
] as const;

export type JobProvenanceField = (typeof JOB_PROVENANCE_FIELDS)[number];

/**
 * Where one Job field came from. `provenance` is always recorded; UNKNOWN is a
 * valid value but never silently becomes `false` or negative evidence (ENG-001).
 */
export interface FieldProvenance {
  /** Source text, a deterministic rule, or AI (SRS ENG-003). */
  provenance: ProvenanceSource;
  /**
   * Identifier of the rule/AI method that produced the value, e.g.
   * `ETHIOPIAN_CALENDAR_V1`; null when the value passed through unchanged.
   */
  conversionMethod: string | null;
  /** Source-text slice supporting the value, for debugging and reprocessing. */
  evidence: string | null;
}

/** Per-field provenance for a Job. Fields with no recorded origin are omitted. */
export type JobProvenance = Partial<Record<JobProvenanceField, FieldProvenance>>;
