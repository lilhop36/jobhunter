import type {
  ApplicationMethod,
  CalendarType,
  DescriptionQuality,
  EmploymentType,
  LifecycleStatus,
  LocationCategory,
  RemoteStatus,
  SalaryPeriod,
  SalaryType,
} from '@domain/enums';
import type { DecimalAmount, Probability } from '@domain/types';

/**
 * Read model for the two job routes (SRS 3.4 `GET /api/jobs` and `GET /api/jobs/:id`).
 *
 * Separate from `JobRepository`, which is the ingestion store: that port writes what a collection
 * run observed and answers the lifecycle policy, while this one only publishes what is stored for
 * a client to render. Keeping them apart means a read route cannot reach a write, and the read
 * shape can carry what a client needs (`sourceName`, the salary as an exact amount) without
 * widening the ingestion boundary.
 *
 * SRS 3.4 fixes the endpoints but no body, so the fields below are SRS 5.2's Job attributes. The
 * list is deliberately thinner than the detail: SRS 3.1 asks a low-bandwidth client not to fetch
 * what it will not render, so the description and the per-field provenance belong to the detail.
 *
 * Nothing here is derived. A value the source did not state is `null` (or the domain's UNKNOWN
 * enum), because a read model that fills a gap would turn "not collected" into a fact (ENG-001).
 */
export interface JobSummary {
  id: string;
  sourceId: string;
  sourceName: string;
  canonicalUrl: string | null;
  title: string | null;
  company: string | null;
  descriptionQuality: DescriptionQuality;
  locationText: string | null;
  locationCategory: LocationCategory;
  remoteStatus: RemoteStatus;
  employmentType: EmploymentType;
  /** Exact amount as a string (ENG-006), or null when the source disclosed none. */
  salaryType: SalaryType;
  salaryMin: DecimalAmount | null;
  salaryMax: DecimalAmount | null;
  salaryCurrency: string | null;
  salaryPeriod: SalaryPeriod;
  publishedAt: Date | null;
  lifecycleStatus: LifecycleStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One job as the detail route publishes it: the summary plus the body text, the application
 * path, and the provenance SRS 5.4/FR-011 requires to stay distinguishable.
 */
export interface JobDetail extends JobSummary {
  description: string | null;
  publishedCalendar: CalendarType;
  originalPublishedDateText: string | null;
  dateConfidence: Probability | null;
  salaryConfidence: Probability | null;
  /** The source text the salary was parsed from, or null. */
  salaryEvidence: string | null;
  application: {
    method: ApplicationMethod;
    applyUrl: string | null;
    applyEmail: string | null;
  };
  /**
   * Per-field origin (SRS 5.4, ENG-003), exactly as stored — including the source text each value
   * came from. Published without reinterpretation because the map was written by the pipeline
   * revision that produced these facts; validating it against today's field list would hide an
   * older revision's evidence rather than show it. `null` when the row stores none.
   */
  provenance: unknown;
}

/**
 * Where a page ended: the last Job's `(createdAt, id)`. See `ListJobsOptions.order`.
 */
export interface JobCursor {
  createdAt: Date;
  id: string;
}

export interface ListJobsOptions {
  /**
   * Order is `createdAt` DESC then `id` DESC — discovery order, newest first.
   *
   * `publishedAt` would be the more interesting sort, but it is nullable (a posting that states
   * no date is UNKNOWN, not old), and a keyset over a nullable column either skips those rows or
   * needs a sentinel. `createdAt` is always known, so paging is exact.
   *
   * ponytail: SRS 5.6 lists no index for this order, so the page sort is a full scan plus a
   * sort. Fine while `jobs` is small; add `(createdAt DESC, id DESC)` when a page stops being
   * instant.
   */
  sourceId?: string;
  lifecycleStatus?: LifecycleStatus;
  limit: number;
  cursor?: JobCursor | null;
}

export interface ListJobsPage {
  jobs: JobSummary[];
  nextCursor: JobCursor | null;
}

export interface JobReader {
  /** One page of stored jobs, newest discovery first (SRS 3.4 `GET /api/jobs`). */
  listJobs(options: ListJobsOptions): Promise<ListJobsPage>;

  /** One stored job with its provenance, or null when the id is not stored. */
  findJob(id: string): Promise<JobDetail | null>;

  /**
   * The summaries for these ids, keyed by id — one query for a page of matches rather than one
   * read per row. An id that is not stored is simply absent from the map; a list read a moment ago
   * may name a job that has since been removed, and that is a normal state.
   */
  findJobsByIds(ids: readonly string[]): Promise<Map<string, JobSummary>>;
}
