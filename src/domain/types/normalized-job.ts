import {
  ApplicationMethod,
  DescriptionQuality,
  EmploymentType,
  LocationCategory,
  RemoteStatus,
} from '../enums';
import { DateParsed } from './date-parsed';
import { DeadlineParsed } from './deadline-parsed';
import { JobProvenance } from './field-provenance';
import { SalaryParsed } from './salary-parsed';

/**
 * How a job may be applied to (SRS 3.5 / FR-006). `method` is UNKNOWN when no
 * permitted application path was found; the job then does not qualify for
 * notification (AC-004) unless the source is explicitly permitted.
 */
export interface ApplicationTarget {
  method: ApplicationMethod;
  applyUrl: string | null;
  applyEmail: string | null;
  /** Source text supporting the detected method, or null. */
  evidence: string | null;
}

/**
 * Canonical, evidence-derived view of one job, produced by
 * `JobSourceAdapter.normalize`. Field names mirror the `Job` entity (SRS 5.2)
 * so persistence is a direct mapping.
 *
 * Required enums default to UNKNOWN rather than null: absence of evidence is a
 * valid state and must not be represented as a negative fact (ENG-001).
 */
export interface NormalizedJob {
  canonicalUrl: string | null;
  title: string | null;
  company: string | null;
  description: string | null;
  /** SUFFICIENT / PARTIAL / UNUSABLE — never null, never UNKNOWN (Appendix E). */
  descriptionQuality: DescriptionQuality;
  locationText: string | null;
  locationCategory: LocationCategory;
  remoteStatus: RemoteStatus;
  publishedDate: DateParsed;
  /**
   * The application deadline the source stated, or UNKNOWN. Read from the description's own
   * labelled text (`DEADLINE_EXTRACTION_V1`), never inferred from the posting's age.
   */
  applicationDeadline: DeadlineParsed;
  salary: SalaryParsed;
  employmentType: EmploymentType;
  application: ApplicationTarget;
  contentFingerprint: string | null;
  /** Per-field origin (ENG-003). Omitted fields were not derived. */
  provenance: JobProvenance;
}
