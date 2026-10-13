import { HealthStatus } from '../enums';

/**
 * Result of a source health check (SRS 3.5 `healthCheck`), mirroring the
 * `JobSource.healthStatus` field. A check reports what it observed; it never
 * asserts health it did not verify.
 */
export interface HealthResult {
  status: HealthStatus;
  /** When the check ran. Injected by the pipeline, never read from the wall clock. */
  checkedAt: Date;
  /** Number of items sampled, or null when the check did not sample. */
  sampleSize: number | null;
  /** Concrete non-fabricated detail (HTTP status, error, ...), or null. */
  detail: string | null;
}
