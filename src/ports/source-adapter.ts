import { CalendarType } from '@domain/enums';
import type {
  DeclaredDateFormat,
  HealthResult,
  NormalizedJob,
  RawJobEvidence,
  SourceResultExpectation,
} from '@domain/types';
import { WorkerLogger } from './worker-logger';

/**
 * How a source's content may be acquired. Part of the source approval record
 * (SRS Appendix E). HTTP/feed/API/static parsing is always attempted before
 * browser automation; `BROWSER` is a last resort (SRS 7.7).
 */
export type AccessMechanism = 'FEED' | 'API' | 'STATIC_HTML' | 'BROWSER';

/**
 * Per-source configuration a `JobSourceAdapter` is constructed with. Only the
 * values the SRS requires a source to *declare* live here; anything else is
 * adapter-specific and belongs in `options`.
 */
export interface SourceAdapterConfig {
  /** Canonical `JobSource.id` this adapter serves. */
  sourceId: string;
  /** Adapter type/version recorded on the `JobSource` (FR-001). */
  adapterType: string;
  adapterVersion: string;
  accessMechanism: AccessMechanism;
  /**
   * Declared source calendar. Used only as an explicit signal; it never
   * overrides per-item evidence (SRS Appendix E, "Calendar detection").
   */
  declaredCalendar: CalendarType;
  /**
   * Declared numeric date format used only as an explicit signal for
   * otherwise-ambiguous numeric dates, or null when the source declares none
   * (SRS Appendix E, "Calendar detection"). Requires `declaredCalendar` to be
   * declared as well; the shared date normalizer never guesses the order.
   */
  declaredDateFormat: DeclaredDateFormat | null;
  /**
   * Declared ISO-4217 currency used only as an explicit signal, or null when
   * the source declares none (SRS Appendix E, "Salary currency and period").
   */
  declaredCurrency: string | null;
  /**
   * Declares whether this source's job URLs are canonical *job-detail* URLs suitable as a
   * source-record identity basis (ADR-0001 concept 1).
   *
   * Set this only from a signed source approval record that has verified the adapter's
   * `sourceUrl` is stable across re-collection for the same posting, and is not a listing
   * page, a paginated page, or a shared careers URL fronting many postings. When false the
   * pipeline skips URL identity entirely and moves to the title/company/location fallback.
   *
   * Required, and with no default, so a source cannot silently inherit URL trust it never
   * verified. It is the declaration the identity resolver will not assume (see
   * `resolveSourceRecordIdentity`).
   */
  canonicalUrlIdentityTrusted: boolean;
  /**
   * Declares whether a run of this source is expected to find postings (SRS Appendix E,
   * "Expected results"; AC-018).
   *
   * It lives beside the other approved declarations because it is one: the approval record
   * states it, nothing derives it. `UNKNOWN` (the default when absent) never raises the
   * unexpected-zero-result signal, which is the safe direction for a source that genuinely
   * publishes nothing some days. A source approved as `RESULTS_EXPECTED` that returns zero
   * must be reported, or a dead source looks healthy.
   *
   * Optional so a source added before this declaration existed keeps its old behaviour
   * rather than silently inheriting an expectation nobody approved.
   */
  resultExpectation?: SourceResultExpectation;
  /** Adapter-specific options (feed URL, selectors, ...); opaque to the pipeline. */
  options: Readonly<Record<string, unknown>>;
}

/** Runtime context for one collection pass. */
export interface CollectionContext {
  /** `SourceRun.id` this collection is recorded under. */
  sourceRunId: string;
  /**
   * Current time, injected so runs are reproducible and testable (ENG-012).
   * Adapters must not read the wall clock directly.
   */
  now: Date;
  /** Cooperative cancellation; adapters should stop between requests when set. */
  signal?: AbortSignal;
  logger: WorkerLogger;
}

/** Runtime context for a health check. */
export interface HealthCheckContext {
  /** Injected current time (ENG-012). */
  now: Date;
  signal?: AbortSignal;
  logger: WorkerLogger;
}

/**
 * What one collection pass returned.
 *
 * `catalogueExhausted` says this pass read the source's listing to its end, so a record it
 * did not observe is evidence that the source stopped publishing it (FR-019). A pass cut
 * short by a page budget, a fetch failure or an abort says nothing about what it did not
 * see, and must report `false`. Reporting `true` without having reached the end of the
 * listing would let the lifecycle sweep retire live postings.
 *
 * `oldestListingPublishedAt` is the narrower claim a capped pass can still make: the oldest
 * publication date among the listing entries it read. A record published strictly after
 * this floor was inside the window the pass saw; entries at or before it may lie beyond the
 * pages read (published dates are date-only, so the floor date itself is excluded). `null`
 * means no window claim: an entry was unreadable or undated, or the pass was aborted.
 */
export interface CollectionResult {
  records: RawJobEvidence[];
  catalogueExhausted: boolean;
  oldestListingPublishedAt: Date | null;
  /**
   * Pages the source answered with an HTTP error status (403, 429, 500 …).
   *
   * This is a source-health signal, not a parse miss: a listing that answers 403 produced no
   * records for a reason that has nothing to do with the adapter's reading of a page it did get.
   * Counting it is what lets SRS 7.8's HTTP-failure metric say "the source is failing" instead of
   * "the source published nothing" (audit M5). The 404/410 that proves the end of the catalogue is
   * expected evidence of a healthy source and is deliberately not counted here.
   */
  httpFailures: number;
}

/**
 * Port for a single job source (SRS 3.5 / 7.7).
 *
 * An implementation represents exactly one configured source and is built from
 * its `SourceAdapterConfig`. The shared pipeline owns persistence,
 * deduplication and run accounting; adapters only acquire and interpret source
 * content.
 *
 * `normalize` MUST delegate URL, salary, date, location and fingerprint work to
 * `@domain/normalizers` rather than reimplementing it (ENG-016). Values that
 * cannot be derived from evidence are UNKNOWN/null, never fabricated (ENG-001).
 */
export interface JobSourceAdapter {
  readonly config: SourceAdapterConfig;
  /** Fetch and parse source content into canonical raw evidence, and report listing coverage. */
  collect(context: CollectionContext): Promise<CollectionResult>;
  /** Map raw evidence to canonical Job fields (SRS 3.5 `normalize`). */
  normalize(raw: RawJobEvidence): Promise<NormalizedJob>;
  /** Report source health, without a full collection where feasible. */
  healthCheck(context: HealthCheckContext): Promise<HealthResult>;
}
