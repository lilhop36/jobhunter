import type { PrismaClient } from '@prisma/client';
import { RunSourceCollection } from '@application/ingestion';
import { PermanentWorkTaskError, type WorkTaskHandler } from '@application/worker';
import type { HealthResult, NormalizedJob, RawJobEvidence } from '@domain/types';
import { PrismaJobRepository } from '@infrastructure/ingestion/prisma-job-repository';
import { PrismaRawJobRepository } from '@infrastructure/ingestion/prisma-raw-job-repository';
import { PrismaSourceRunRepository } from '@infrastructure/ingestion/prisma-source-run-repository';
import type {
  CollectionContext,
  HealthCheckContext,
  JobSourceAdapter,
} from '@ports/source-adapter';
import { silentWorkerLogger } from '@ports/worker-logger';
import { FakeSourceAdapter, makeFakeConfig, makeRawJob } from '../../support/fake-source-adapter';

/**
 * Shared fixtures for the collection crash test.
 *
 * The child process and the parent test must agree on the task type, the record set,
 * and *where* the child blocks, so both import these values instead of duplicating
 * literals that could silently drift apart.
 */

/** Task type whose handler runs one collection. */
export const COLLECTION_TASK_TYPE = 'failure.collection-task';

/**
 * Safety bound handed to `RunSourceCollection`. Short so the recovery wait in the
 * test is brief, while still being a real time-based bound evaluated on the database
 * clock - the abandoned run is recovered because its owner died, not because the test
 * rewrote its state.
 */
export const COLLECTION_STALE_RUN_SECONDS = 1;

/**
 * Acquisition bound handed to `RunSourceCollection`.
 *
 * The crash harness blocks in `normalize`, not `collect`, so the fast fake acquisition
 * must never trip this bound: the run only ends when the process is killed, which is the
 * durable state the test asserts. Generous on purpose.
 */
export const COLLECTION_ACQUISITION_TIMEOUT_MS = 60_000;

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
 * `blockOn: null` gives the same records without the block, so the recovery run
 * exercises the identical pipeline and simply completes.
 */
function makeCollectionAdapter(sourceId: string, blockOn: string | null): JobSourceAdapter {
  const inner = new FakeSourceAdapter(makeFakeConfig({ sourceId }), collectionRecords());
  return {
    get config() {
      return inner.config;
    },
    collect: (context: CollectionContext) => inner.collect(context),
    normalize: (raw: RawJobEvidence): Promise<NormalizedJob> =>
      blockOn !== null && raw.sourceJobIdentifier === blockOn
        ? new Promise<NormalizedJob>(() => undefined)
        : inner.normalize(raw),
    healthCheck: (context: HealthCheckContext): Promise<HealthResult> => inner.healthCheck(context),
  };
}

/** Payload of a collection task. */
export function collectionTaskPayload(sourceId: string): { sourceId: string } {
  return { sourceId };
}

function sourceIdFromTaskPayload(payload: unknown): string {
  const sourceId = (payload as { sourceId?: unknown } | null)?.sourceId;
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new PermanentWorkTaskError('collection task payload requires a sourceId');
  }
  return sourceId;
}

/**
 * Handler that collects one source, shared by the child process and the recovery
 * worker, so the recovered attempt runs the same code path as the crashed one.
 */
export function createCollectionHandler(
  prisma: PrismaClient,
  blockOn: string | null,
): WorkTaskHandler {
  const collection = new RunSourceCollection({
    sourceRuns: new PrismaSourceRunRepository(prisma),
    rawJobs: new PrismaRawJobRepository(prisma),
    jobs: new PrismaJobRepository(prisma),
    logger: silentWorkerLogger,
  });

  return async ({ task }) => {
    const sourceId = sourceIdFromTaskPayload(task.payload);
    await collection.run({
      adapter: makeCollectionAdapter(sourceId, blockOn),
      now: new Date(),
      staleRunSeconds: COLLECTION_STALE_RUN_SECONDS,
      acquisitionTimeoutMs: COLLECTION_ACQUISITION_TIMEOUT_MS,
    });
  };
}
