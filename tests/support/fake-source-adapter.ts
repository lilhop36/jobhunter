import {
  ApplicationMethod,
  CalendarType,
  DescriptionQuality,
  EmploymentType,
  HealthStatus,
  ProvenanceSource,
  SalaryType,
} from '@domain/enums';
import type { HealthResult, NormalizedJob, RawJobEvidence } from '@domain/types';
import { parseDate } from '@domain/normalizers/calendar';
import { classifyLocation } from '@domain/normalizers/location/location-classifier';
import { parseSalary } from '@domain/normalizers/salary-normalizer';
import { canonicalizeUrl, contentFingerprint } from '@domain/normalizers/url-normalizer';
import type {
  CollectionContext,
  HealthCheckContext,
  JobSourceAdapter,
  SourceAdapterConfig,
} from '@ports/source-adapter';

/** Builds a `SourceAdapterConfig` with test defaults. */
export function makeFakeConfig(overrides: Partial<SourceAdapterConfig> = {}): SourceAdapterConfig {
  return {
    sourceId: '00000000-0000-0000-0000-000000000001',
    adapterType: 'FAKE',
    adapterVersion: '1.0.0',
    accessMechanism: 'API',
    declaredCalendar: CalendarType.UNKNOWN,
    declaredDateFormat: null,
    declaredCurrency: null,
    options: {},
    ...overrides,
  };
}

/** Builds `RawJobEvidence` with test defaults (every evidence field absent). */
export function makeRawJob(overrides: Partial<RawJobEvidence> = {}): RawJobEvidence {
  return {
    sourceJobIdentifier: null,
    sourceUrl: null,
    rawTitle: null,
    rawCompany: null,
    rawLocation: null,
    rawDescription: null,
    rawPublishedDateText: null,
    rawSalaryText: null,
    rawPayload: null,
    collectedAt: null,
    ...overrides,
  };
}

/**
 * Test double for `JobSourceAdapter`.
 *
 * It performs no network I/O: `collect` returns whatever was seeded and
 * `normalize` demonstrates the required delegation to `@domain/normalizers`.
 * It is intentionally dumb — it exists to pin the contract shape, not to model
 * a real source.
 */
export class FakeSourceAdapter implements JobSourceAdapter {
  readonly config: SourceAdapterConfig;
  private readonly rows: RawJobEvidence[];

  constructor(config: SourceAdapterConfig = makeFakeConfig(), rows: RawJobEvidence[] = []) {
    this.config = config;
    this.rows = rows;
  }

  async collect(_context: CollectionContext): Promise<RawJobEvidence[]> {
    return this.rows.map((row) => ({ ...row }));
  }

  async normalize(raw: RawJobEvidence): Promise<NormalizedJob> {
    const canonicalUrl = canonicalizeUrl(raw.sourceUrl);
    const location = classifyLocation({ text: raw.rawLocation });
    const salary = parseSalary(raw.rawSalaryText);

    const fingerprintInput = [raw.rawTitle, raw.rawCompany, raw.rawDescription]
      .filter((value): value is string => Boolean(value))
      .join(' ');
    const fingerprint = fingerprintInput ? contentFingerprint(fingerprintInput) : null;

    // Delegated to the shared date normalizer (ENG-016); no calendar is guessed
    // without an explicit signal, so this exercises "UNKNOWN is a valid state".
    const publishedDate = parseDate({
      text: raw.rawPublishedDateText,
      sourceCalendarHint: this.config.declaredCalendar,
      declaredDateFormat: this.config.declaredDateFormat,
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
      provenance.title = {
        provenance: ProvenanceSource.SOURCE,
        conversionMethod: null,
        evidence: raw.rawTitle,
      };
    }
    if (raw.rawCompany) {
      provenance.company = {
        provenance: ProvenanceSource.SOURCE,
        conversionMethod: null,
        evidence: raw.rawCompany,
      };
    }
    if (raw.rawDescription) {
      provenance.description = {
        provenance: ProvenanceSource.SOURCE,
        conversionMethod: null,
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
    if (salary.type !== SalaryType.UNKNOWN) {
      provenance.salaryType = {
        provenance: ProvenanceSource.DETERMINISTIC,
        conversionMethod: 'SALARY_PARSER_V1',
        evidence: raw.rawSalaryText,
      };
    }
    if (fingerprint) {
      provenance.contentFingerprint = {
        provenance: ProvenanceSource.DETERMINISTIC,
        conversionMethod: 'CONTENT_FINGERPRINT_V1',
        evidence: null,
      };
    }

    const hasDescription = Boolean(raw.rawDescription && raw.rawDescription.trim());

    return {
      canonicalUrl,
      title: raw.rawTitle,
      company: raw.rawCompany,
      description: raw.rawDescription,
      // Presence-only rule for the test double; the real quality classifier
      // (Appendix E) lands with the extraction stage.
      descriptionQuality: hasDescription ? DescriptionQuality.SUFFICIENT : DescriptionQuality.UNUSABLE,
      locationText: raw.rawLocation,
      locationCategory: location.category,
      remoteStatus: location.remoteStatus,
      publishedDate,
      salary,
      employmentType: EmploymentType.UNKNOWN,
      application: {
        method: ApplicationMethod.UNKNOWN,
        applyUrl: null,
        applyEmail: null,
        evidence: null,
      },
      contentFingerprint: fingerprint,
      provenance,
    };
  }

  async healthCheck(context: HealthCheckContext): Promise<HealthResult> {
    return {
      status: this.rows.length > 0 ? HealthStatus.HEALTHY : HealthStatus.UNKNOWN,
      checkedAt: context.now,
      sampleSize: this.rows.length,
      detail: null,
    };
  }
}
