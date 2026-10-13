/**
 * Source-specific collection output.
 *
 * Mirrors the `RawJob` entity attributes (SRS 5.2) minus persistence identity
 * (`id`, `sourceId`, `sourceRunId`). Adapters emit these; the pipeline persists
 * each as a `raw_jobs` row. Raw evidence is never mutated by downstream stages
 * (ENG-002).
 *
 * Every attribute is nullable because the absence of evidence is representable:
 * a missing value is `null`, never fabricated (ENG-001).
 */
export interface RawJobEvidence {
  /** Stable identifier assigned by the source, when the source has one. */
  sourceJobIdentifier: string | null;
  sourceUrl: string | null;
  rawTitle: string | null;
  rawCompany: string | null;
  rawLocation: string | null;
  rawDescription: string | null;
  rawPublishedDateText: string | null;
  rawSalaryText: string | null;
  /** Opaque source payload preserved for debugging and reprocessing. */
  rawPayload: unknown;
  /** Collection time reported by the source, or null to let the pipeline stamp it. */
  collectedAt: Date | null;
}
