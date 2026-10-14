import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunSourceCollection } from '@application/ingestion';
import { HealthStatus, SourceRunStatus } from '@domain/enums';
import { SourceResultExpectation, type RawJobEvidence } from '@domain/types';
import type { CollectionContext } from '@ports/source-adapter';
import { silentWorkerLogger } from '@ports/worker-logger';
import { PrismaJobRepository } from '@infrastructure/ingestion/prisma-job-repository';
import { PrismaJobSourceRepository } from '@infrastructure/ingestion/prisma-job-source-repository';
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
  jobSources: new PrismaJobSourceRepository(prisma),
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

async function run(adapter: FakeSourceAdapter, expectation?: SourceResultExpectation) {
  return collection.run({
    adapter,
    now: NOW,
    staleRunSeconds: STALE_SECONDS,
    acquisitionTimeoutMs: ACQUISITION_TIMEOUT_MS,
    ...(expectation === undefined ? {} : { resultExpectation: expectation }),
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

    await run(adapterFor(sourceId, []), SourceResultExpectation.RESULTS_EXPECTED);

    const source = await healthOf(sourceId);
    expect(source.healthStatus).toBe(HealthStatus.DEGRADED);
    expect(source.lastErrorAt).not.toBeNull();
    expect(source.lastSuccessfulRunAt).toBeNull();
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
});
