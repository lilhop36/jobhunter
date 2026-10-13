import { CalendarType } from '@domain/enums';
import { DeclaredDateFormat, HealthResult, NormalizedJob, RawJobEvidence } from '@domain/types';
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
  /** Fetch and parse source content into canonical raw evidence. */
  collect(context: CollectionContext): Promise<RawJobEvidence[]>;
  /** Map raw evidence to canonical Job fields (SRS 3.5 `normalize`). */
  normalize(raw: RawJobEvidence): Promise<NormalizedJob>;
  /** Report source health, without a full collection where feasible. */
  healthCheck(context: HealthCheckContext): Promise<HealthResult>;
}
