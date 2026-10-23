import {
  ApplicationMethod,
  CalendarType,
  EmploymentType,
  ProvenanceSource,
  SalaryType,
} from '@domain/enums';
import type {
  ApplicationTarget,
  DeadlineParsed,
  DeclaredDateFormat,
  NormalizedJob,
  RawJobEvidence,
} from '@domain/types';
import { parseDate } from '@domain/normalizers/calendar';
import { classifyLocation } from '@domain/normalizers/location/location-classifier';
import { parseSalary } from '@domain/normalizers/salary-normalizer';
import { contentFingerprintV1 } from '@domain/normalizers/job-identity';
import {
  DESCRIPTION_QUALITY_VERSION,
  classifyDescriptionQuality,
} from '@domain/normalizers/description-quality';
import {
  EMPLOYMENT_TYPE_VERSION,
  classifyEmploymentType,
} from '@domain/normalizers/employment-type';
import { DEADLINE_EXTRACTION_VERSION, parseDeadline } from '@domain/normalizers/deadline';
import {
  APPLICATION_TARGET_VERSION,
  DECLARED_APPLICATION_TARGET_VERSION,
  resolveApplicationTarget,
} from '@domain/normalizers/application-target';
import { canonicalizeUrl } from '@domain/normalizers/url-normalizer';
import type { SourceAdapterConfig } from '@ports/source-adapter';

/**
 * Declared, source-specific evidence an adapter has already mapped to canonical shapes.
 *
 * Kept out of `RawJobEvidence` because it is interpretation, not capture: the raw payload
 * stays the audit trail, and a normalizer policy change can re-derive this block.
 */
export interface DeclaredRecordEvidence {
  /**
   * A canonical target the adapter mapped from the source's own structured fields. Declared
   * evidence outranks text inference: the publisher stated it, a regex only guessed it. The
   * adapter owns the mapping because the field names and codes are source-specific (ENG-016).
   */
  application?: ApplicationTarget | null;
  /**
   * Deadline text the source declares structurally (an ISO expiry, say). Parsed by the same
   * shared date parser as every other date, so no format is guessed.
   */
  deadlineText?: string | null;
}

/** A declared deadline, or null when the text is absent or not a parsable date. */
function parseDeclaredDeadline(
  text: string | null | undefined,
  declared: { declaredCalendar: CalendarType; declaredDateFormat: DeclaredDateFormat | null },
): DeadlineParsed | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const parsed = parseDate({
    text,
    sourceCalendarHint: declared.declaredCalendar,
    declaredDateFormat: declared.declaredDateFormat,
    // A deadline is an absolute date the publisher stated; there is no relative reference to
    // resolve, and offering the collection time would let "in two weeks" invent one.
    collectedAt: null,
  });
  if (parsed.publishedAt === null) return null;
  return {
    deadlineAt: parsed.publishedAt,
    evidence: text,
    conversionMethod: parsed.conversionMethod,
  };
}

/**
 * The `normalize` half of the adapter contract (SRS 3.5, ENG-016): map raw evidence to
 * canonical Job fields by delegating every derivation to the shared, versioned domain
 * normalizers, and record per-field provenance (ENG-003).
 *
 * Every adapter's `normalize` is this function: the acquisition-specific work is `collect`;
 * normalization policy is shared so it cannot drift between sources. The test double in
 * `tests/support/fake-source-adapter.ts` implements the same delegation inline.
 */
export async function normalizeRawEvidence(
  raw: RawJobEvidence,
  declared: { declaredCalendar: CalendarType; declaredDateFormat: DeclaredDateFormat | null },
  record: DeclaredRecordEvidence = {},
): Promise<NormalizedJob> {
  const canonicalUrl = canonicalizeUrl(raw.sourceUrl);
  const location = classifyLocation({ text: raw.rawLocation });
  const salary = parseSalary(raw.rawSalaryText);
  const employment = classifyEmploymentType({
    title: raw.rawTitle,
    description: raw.rawDescription,
  });
  const extractedApplication = resolveApplicationTarget({
    title: raw.rawTitle,
    description: raw.rawDescription,
  });
  const declaredApplication =
    record.application && record.application.method !== ApplicationMethod.UNKNOWN
      ? record.application
      : null;
  const application = declaredApplication ?? extractedApplication;
  // Read from the description's own labelled text; a source that states no deadline leaves
  // this UNKNOWN, which is not the same claim as "the posting never closes". A deadline the
  // source declares structurally (a `date_expiry` field) is stronger evidence than a text
  // scan, so it wins; an unparsable declared value falls back to the text rather than
  // discarding a deadline the description states.
  const extractedDeadline = parseDeadline({
    description: raw.rawDescription,
    sourceCalendarHint: declared.declaredCalendar,
    declaredDateFormat: declared.declaredDateFormat,
  });
  const applicationDeadline =
    parseDeclaredDeadline(record.deadlineText, declared) ?? extractedDeadline;

  // Delegated to the shared versioned fingerprint module (ENG-016, ADR-0001). Unlike
  // `rawContentHash`, an all-absent record yields null rather than a digest of nothing:
  // "no evidence" must stay distinguishable from "evidence that happens to be empty".
  const hasFingerprintInput = [
    raw.rawTitle,
    raw.rawCompany,
    raw.rawLocation,
    raw.rawDescription,
    canonicalUrl,
  ].some((value) => Boolean(value && value.trim()));
  const fingerprint = hasFingerprintInput
    ? contentFingerprintV1({
        title: raw.rawTitle,
        company: raw.rawCompany,
        locationText: raw.rawLocation,
        description: raw.rawDescription,
        canonicalUrl,
      })
    : null;

  // Delegated to the shared date normalizer (ENG-016); no calendar is guessed without an
  // explicit signal, so an absent date text stays UNKNOWN ("UNKNOWN is a valid state").
  const publishedDate = parseDate({
    text: raw.rawPublishedDateText,
    sourceCalendarHint: declared.declaredCalendar,
    declaredDateFormat: declared.declaredDateFormat,
    collectedAt: raw.collectedAt,
  });

  const provenance: NormalizedJob['provenance'] = {};
  if (canonicalUrl) {
    provenance.canonicalUrl = {
      provenance: ProvenanceSource.DETERMINISTIC,
      conversionMethod: 'URL_CANONICALIZE_V1',
      evidence: raw.sourceUrl,
    };
  }
  if (raw.rawTitle) {
    provenance.title = { provenance: ProvenanceSource.SOURCE, conversionMethod: null, evidence: raw.rawTitle };
  }
  if (raw.rawCompany) {
    provenance.company = { provenance: ProvenanceSource.SOURCE, conversionMethod: null, evidence: raw.rawCompany };
  }
  if (raw.rawDescription) {
    provenance.description = {
      provenance: ProvenanceSource.SOURCE,
      conversionMethod: null,
      evidence: null,
    };
    // Derived deterministically from the captured text, so DETERMINISTIC with the policy
    // version that produced it (ENG-003, FR-007).
    provenance.descriptionQuality = {
      provenance: ProvenanceSource.DETERMINISTIC,
      conversionMethod: DESCRIPTION_QUALITY_VERSION,
      evidence: null,
    };
  }
  if (raw.rawLocation) {
    provenance.locationText = {
      provenance: ProvenanceSource.SOURCE,
      conversionMethod: null,
      evidence: raw.rawLocation,
    };
    provenance.locationCategory = {
      provenance: ProvenanceSource.DETERMINISTIC,
      conversionMethod: 'LOCATION_GAZETTEER_V1',
      evidence: raw.rawLocation,
    };
  }
  if (publishedDate.calendar !== CalendarType.UNKNOWN) {
    provenance.originalPublishedDateText = {
      provenance: ProvenanceSource.SOURCE,
      conversionMethod: null,
      evidence: raw.rawPublishedDateText,
    };
    provenance.publishedCalendar = {
      provenance: ProvenanceSource.DETERMINISTIC,
      conversionMethod: publishedDate.conversionMethod,
      evidence: raw.rawPublishedDateText,
    };
    if (publishedDate.publishedAt) {
      provenance.publishedAt = {
        provenance: ProvenanceSource.DETERMINISTIC,
        conversionMethod: publishedDate.conversionMethod,
        evidence: raw.rawPublishedDateText,
      };
    }
  }
  if (applicationDeadline.deadlineAt !== null) {
    provenance.applicationDeadline = {
      provenance: ProvenanceSource.DETERMINISTIC,
      conversionMethod: applicationDeadline.conversionMethod ?? DEADLINE_EXTRACTION_VERSION,
      evidence: applicationDeadline.evidence,
    };
  }
  if (salary.type !== SalaryType.UNKNOWN) {
    provenance.salaryType = {
      provenance: ProvenanceSource.DETERMINISTIC,
      conversionMethod: 'SALARY_PARSER_V1',
      evidence: raw.rawSalaryText,
    };
  }
  if (employment.type !== EmploymentType.UNKNOWN) {
    provenance.employmentType = {
      provenance: ProvenanceSource.DETERMINISTIC,
      conversionMethod: EMPLOYMENT_TYPE_VERSION,
      evidence: employment.evidence,
    };
  }
  if (application.method !== ApplicationMethod.UNKNOWN) {
    // The version records which policy produced the target: text inference or a source's own
    // declared field. Both are deterministic derivations, not source-stated canon, because a
    // source code was mapped to a canonical enum.
    const applicationVersion =
      declaredApplication === null
        ? APPLICATION_TARGET_VERSION
        : DECLARED_APPLICATION_TARGET_VERSION;
    provenance.applicationMethod = {
      provenance: ProvenanceSource.DETERMINISTIC,
      conversionMethod: applicationVersion,
      evidence: application.evidence,
    };
    if (application.applyUrl !== null) {
      provenance.applyUrl = {
        provenance: ProvenanceSource.DETERMINISTIC,
        conversionMethod: applicationVersion,
        evidence: application.evidence,
      };
    }
    if (application.applyEmail !== null) {
      provenance.applyEmail = {
        provenance: ProvenanceSource.DETERMINISTIC,
        conversionMethod: applicationVersion,
        evidence: application.evidence,
      };
    }
  }
  if (fingerprint) {
    provenance.contentFingerprint = {
      provenance: ProvenanceSource.DETERMINISTIC,
      conversionMethod: 'CONTENT_FINGERPRINT_V1',
      evidence: null,
    };
  }

  return {
    canonicalUrl,
    title: raw.rawTitle,
    company: raw.rawCompany,
    description: raw.rawDescription,
    descriptionQuality: classifyDescriptionQuality(raw.rawDescription),
    locationText: raw.rawLocation,
    locationCategory: location.category,
    remoteStatus: location.remoteStatus,
    publishedDate,
    applicationDeadline,
    salary,
    employmentType: employment.type,
    application,
    contentFingerprint: fingerprint,
    provenance,
  };
}
