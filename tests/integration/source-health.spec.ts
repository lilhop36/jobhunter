import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunSourceCollection } from '@application/ingestion';
import { HealthStatus, SourceRunStatus } from '@domain/enums';
import { SourceResultExpectation, type RawJobEvidence } from '@domain/types';
import type { CollectionContext } from '@ports/source-adapter';
import { silentWorkerLogger } from '@ports/worker-logger';
import { PrismaJobRepository } from '@infrastructure/ingestion/prisma-job-repository';
import { PrismaRawJobRepository } from '@infrastructure/ingestion/prisma-raw-job-repository';
import { PrismaSourceRunRepository } from '@infrastructure/ingestion/prisma-source-run-repository';
import { FakeSourceAdapter, makeFakeConfig, makeRawJob } from '../support/fake-source-adapter';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * Real-PostgreSQL tests for FR-020 source health (SRS 4.9 / 7.3, AC-018).
 *
 * `JobSource.healthStatus`, `lastSuccessfulRunAt` and `lastErrorAt` are SRS 5.2 attributes
 * that nothing wrote before this, so these tests pin the whole contract: which run
 * outcomes move health, that a failure never erases the last known-good collection, and
 * that an outcome the collection itself discarded is not evidence and moves nothing.
 */

const prisma = createTestPrismaClient();
const collection = new RunSourceCollection({
  sourceRuns: new PrismaSourceRunRepository(prisma),
  rawJobs: new PrismaRawJobRepository(prisma),
  jobs: new PrismaJobRepository(prisma),
  logger: silentWorkerLogger,
});

const NOW = new Date('2026-05-01T10:00:00.000Z');
const STALE_SECONDS = 3600;
const ACQUISITION_TIMEOUT_MS = 30_000;

/** Fails acquisition, the way an unreachable source does. */
class FailingAdapter extends FakeSourceAdapter {
  override async collect(_context: CollectionContext): Promise<RawJobEvidence[]> {
    throw new Error('connection reset by peer');
  }
}

/**
 * Accepts the request and then never answers, the way a wedged source does. Only the
 * acquisition bound can end this run - the adapter itself never settles.
 */
class HangingAdapter extends FakeSourceAdapter {
  override collect(_context: CollectionContext): Promise<RawJobEvidence[]> {
    return new Promise<RawJobEvidence[]>(() => undefined);
  }
}

/**
 * Finishes its own run underneath the collection, so the collection's finalize finds the
 * run already terminal and discards its outcome - exactly what a reaped stale run does.
 */
class ReapingAdapter extends FakeSourceAdapter {
  override async collect(context: CollectionContext): Promise<RawJobEvidence[]> {
    await prisma.sourceRun.update({
      where: { id: context.sourceRunId },
      data: { status: SourceRunStatus.FAILED, finishedAt: NOW, errorSummary: 'lease expired' },
    });
    return [];
  }
}

async function createSource(): Promise<string> {
  const source = await prisma.jobSource.create({
    data: { name: `source-${Date.now()}-${Math.random()}`, adapterType: 'FAKE', adapterVersion: '1.0.0' },
  });
  return source.id;
}

async function healthOf(sourceId: string) {
  return prisma.jobSource.findUniqueOrThrow({ where: { id: sourceId } });
}

async function run(
  adapter: FakeSourceAdapter,
  overrides: {
    expectation?: SourceResultExpectation;
    acquisitionTimeoutMs?: number;
    signal?: AbortSignal;
  } = {},
) {
  return collection.run({
    adapter,
    now: NOW,
    staleRunSeconds: STALE_SECONDS,
    acquisitionTimeoutMs: overrides.acquisitionTimeoutMs ?? ACQUISITION_TIMEOUT_MS,
    ...(overrides.expectation === undefined ? {} : { resultExpectation: overrides.expectation }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  });
}

function adapterFor(sourceId: string, rows: RawJobEvidence[]): FakeSourceAdapter {
  return new FakeSourceAdapter(makeFakeConfig({ sourceId }), rows);
}

beforeAll(() => {
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('source health from a completed run', () => {
  it('starts UNKNOWN and is only ever written from a real run', async () => {
    const sourceId = await createSource();

    const source = await healthOf(sourceId);

    expect(source.healthStatus).toBe(HealthStatus.UNKNOWN);
    expect(source.lastSuccessfulRunAt).toBeNull();
    expect(source.lastErrorAt).toBeNull();
  });

  it('marks a source healthy and dates the successful collection', async () => {
    const sourceId = await createSource();

    await run(adapterFor(sourceId, [makeRawJob({ sourceJobIdentifier: 'a-1', rawTitle: 'Engineer' })]));

    const source = await healthOf(sourceId);
    expect(source.healthStatus).toBe(HealthStatus.HEALTHY);
    expect(source.lastSuccessfulRunAt).not.toBeNull();
    expect(source.lastErrorAt).toBeNull();
  });

  it('marks a failing acquisition FAILING with an error time', async () => {
    const sourceId = await createSource();

    await run(new FailingAdapter(makeFakeConfig({ sourceId })));

    const source = await healthOf(sourceId);
    expect(source.healthStatus).toBe(HealthStatus.FAILING);
    expect(source.lastErrorAt).not.toBeNull();
    expect(source.lastSuccessfulRunAt).toBeNull();
  });

  it('degrades a source that returned no results where results were expected (AC-018)', async () => {
    const sourceId = await createSource();

    await run(adapterFor(sourceId, []), {
      expectation: SourceResultExpectation.RESULTS_EXPECTED,
    });

    const source = await healthOf(sourceId);
    expect(source.healthStatus).toBe(HealthStatus.DEGRADED);
    expect(source.lastErrorAt).not.toBeNull();
    expect(source.lastSuccessfulRunAt).toBeNull();
  });

  it('fails a hung acquisition through its own bound, so a wedged source cannot stay HEALTHY (SRS 9.5)', async () => {
    const sourceId = await createSource();

    const result = await run(new HangingAdapter(makeFakeConfig({ sourceId })), {
      acquisitionTimeoutMs: 100,
    });

    expect(result.status).toBe(SourceRunStatus.FAILED);
    // The adapter never settles, so this can only have ended through the acquisition bound.
    // Without a bound the run would stay RUNNING until it was reaped, and a reaped run is
    // deliberately not evidence about the source - health would stay UNKNOWN forever while
    // the source hung on every attempt.
    const source = await healthOf(sourceId);
    expect(source.healthStatus).toBe(HealthStatus.FAILING);
    expect(source.lastErrorAt).not.toBeNull();
    expect(source.lastSuccessfulRunAt).toBeNull();
  });

  it('dates health with the very finish time it recorded on the run', async () => {
    const sourceId = await createSource();

    const result = await run(adapterFor(sourceId, [makeRawJob({ sourceJobIdentifier: 'a-1' })]));

    // Both writes share the database clock inside one transaction, so the column can never
    // disagree with the run it came from.
    const source = await healthOf(sourceId);
    expect(source.lastSuccessfulRunAt).toEqual(result.run?.finishedAt);
  });
});

describe('source health across a sequence of runs', () => {
  it('never erases the last successful collection on failure, and recovers on the next success', async () => {
    const sourceId = await createSource();
    const row = makeRawJob({ sourceJobIdentifier: 'a-1', rawTitle: 'Engineer' });

    await run(adapterFor(sourceId, [row]));
    const afterSuccess = await healthOf(sourceId);
    expect(afterSuccess.healthStatus).toBe(HealthStatus.HEALTHY);

    await run(new FailingAdapter(makeFakeConfig({ sourceId })));
    const afterFailure = await healthOf(sourceId);
    expect(afterFailure.healthStatus).toBe(HealthStatus.FAILING);
    // The whole point of keeping both columns: a failure does not age the last success.
    expect(afterFailure.lastSuccessfulRunAt).toEqual(afterSuccess.lastSuccessfulRunAt);

    await run(adapterFor(sourceId, [row]));
    const afterRecovery = await healthOf(sourceId);
    expect(afterRecovery.healthStatus).toBe(HealthStatus.HEALTHY);
    expect(afterRecovery.lastSuccessfulRunAt!.getTime()).toBeGreaterThanOrEqual(
      afterSuccess.lastSuccessfulRunAt!.getTime(),
    );
    // ...and the failure stays visible even after recovery.
    expect(afterRecovery.lastErrorAt).toEqual(afterFailure.lastErrorAt);
  });

  it('records nothing from an outcome the collection discarded', async () => {
    const sourceId = await createSource();

    const result = await run(new ReapingAdapter(makeFakeConfig({ sourceId })));

    expect(result.run).toBeNull();
    const source = await healthOf(sourceId);
    expect(source.healthStatus).toBe(HealthStatus.UNKNOWN);
    expect(source.lastErrorAt).toBeNull();
  });

  it('leaves health exactly as it was when the worker shut down mid-collection', async () => {
    const sourceId = await createSource();
    const row = makeRawJob({ sourceJobIdentifier: 'a-1', rawTitle: 'Engineer' });

    await run(adapterFor(sourceId, [row]));
    const healthy = await healthOf(sourceId);
    expect(healthy.healthStatus).toBe(HealthStatus.HEALTHY);

    // Shutdown during the record loop: the run is truthfully PARTIAL, but the worker's own
    // restart must not be recorded as the source degrading.
    const duringRecords = new AbortController();
    duringRecords.abort();
    const aborted = await run(adapterFor(sourceId, [row]), { signal: duringRecords.signal });
    expect(aborted.status).toBe(SourceRunStatus.PARTIAL);

    // Shutdown during acquisition: the same rule, reached through the other branch.
    const duringAcquisition = new AbortController();
    duringAcquisition.abort();
    const abortedAcquisition = await run(new FailingAdapter(makeFakeConfig({ sourceId })), {
      signal: duringAcquisition.signal,
    });
    expect(abortedAcquisition.status).toBe(SourceRunStatus.PARTIAL);

    const after = await healthOf(sourceId);
    expect(after.healthStatus).toEqual(healthy.healthStatus);
    expect(after.lastSuccessfulRunAt).toEqual(healthy.lastSuccessfulRunAt);
    expect(after.lastErrorAt).toBeNull();
  });
});
