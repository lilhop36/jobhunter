import type { NormalizedJob, RawJobEvidence } from '@domain/types';
import type { CollectionContext, HealthCheckContext, JobSourceAdapter } from '@ports/source-adapter';
import { FakeSourceAdapter, makeFakeConfig, makeRawJob } from '../../support/fake-source-adapter';

/**
 * Values shared between the collection crash test and the worker entry-point process it
 * starts, so both read one definition instead of duplicating literals that could drift.
 */

/**
 * Safety bound handed to the worker as `SOURCE_STALE_RUN_SECONDS`. Short so the recovery
 * wait in the test is brief, while still being a real time-based bound evaluated on the
 * database clock - the abandoned run is recovered because its owner died, not because the
 * test rewrote its state.
 */
export const COLLECTION_STALE_RUN_SECONDS = 1;

/**
 * Acquisition bound handed to the worker as `SOURCE_ACQUISITION_TIMEOUT_MS`.
 *
 * The harness blocks in `normalize`, not `collect`, so the fake acquisition resolves
 * immediately and must never trip this bound - the run only ends when the process is
 * killed, which is the durable state the test asserts. The value still has to obey the
 * entry point's rule that an acquisition bound must be shorter than the stale-run bound:
 * a run whose own acquisition bound outlived the stale bound could be reaped while it was
 * still alive, so the configuration is rejected outright.
 */
export const COLLECTION_ACQUISITION_TIMEOUT_MS = 500;

/** Identity of the worker process that is killed mid-collection. */
export const COLLECTION_KILLED_WORKER_ID = 'failure-test-collection-killed';

/** Identity of the fresh worker that recovers the abandoned collection. */
export const COLLECTION_RECOVERY_WORKER_ID = 'failure-test-collection-recovery';

/**
 * Identifier whose normalization never settles.
 *
 * The blocking point is chosen so the kill lands at a *deterministic* mid-run state:
 * raw evidence for this record is persisted before `normalize` is entered (SRS 7.7
 * step 4 precedes step 5), so the durable state at the block is exactly
 * "3 raw captures recorded, 2 Jobs promoted, the source run still RUNNING".
 */
export const COLLECTION_BLOCKING_IDENTIFIER = 'blk-3';

/** The records the harness collects. Every one resolves identity via `sid:`. */
export function collectionRecords(): RawJobEvidence[] {
  return [
    makeRawJob({
      sourceJobIdentifier: 'blk-1',
      rawTitle: 'Backend Engineer',
      rawCompany: 'Acme',
    }),
    makeRawJob({
      sourceJobIdentifier: 'blk-2',
      rawTitle: 'Data Analyst',
      rawCompany: 'Acme',
    }),
    makeRawJob({
      sourceJobIdentifier: COLLECTION_BLOCKING_IDENTIFIER,
      rawTitle: 'Platform Engineer',
      rawCompany: 'Acme',
    }),
    makeRawJob({ sourceJobIdentifier: 'blk-4', rawTitle: 'Site Reliability Engineer', rawCompany: 'Acme' }),
  ];
}

/**
 * Adapter over the shared record set, whose `normalize` never settles for `blockOn`.
 *
 * `blockOn: null` gives the same records without the block, so the recovery run exercises
 * the identical pipeline and simply completes. Registered by the test entry point, which
 * is what makes the kill land inside the real collection code path.
 */
export function makeCollectionAdapter(sourceId: string, blockOn: string | null): JobSourceAdapter {
  const inner = new FakeSourceAdapter(makeFakeConfig({ sourceId }), collectionRecords());
  if (blockOn === null) return inner;

  return {
    config: inner.config,
    collect: (context: CollectionContext) => inner.collect(context),
    // Never settles, so the worker is still inside the record loop when it is killed.
    normalize: (raw: RawJobEvidence): Promise<NormalizedJob> =>
      raw.sourceJobIdentifier === blockOn
        ? new Promise<NormalizedJob>(() => undefined)
        : inner.normalize(raw),
    healthCheck: (context: HealthCheckContext) => inner.healthCheck(context),
  };
}

/** Payload of a collection task, in the shape the registered handler parses. */
export function collectionTaskPayload(sourceId: string): { sourceId: string } {
  return { sourceId };
}
