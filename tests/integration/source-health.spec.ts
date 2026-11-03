import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunSourceCollection } from '@application/ingestion';
import { HealthStatus, SourceRunStatus } from '@domain/enums';
import {
  SourceResultExpectation,
  type NormalizedJob,
  type RawJobEvidence,
} from '@domain/types';
import type { CollectionContext, CollectionResult } from '@ports/source-adapter';
import { silentWorkerLogger, type WorkerLogger } from '@ports/worker-logger';
import { PrismaJobRepository } from '@infrastructure/ingestion/prisma-job-repository';
import { PrismaRawJobRepository } from '@infrastructure/ingestion/prisma-raw-job-repository';
import { PrismaSourceRunRepository } from '@infrastructure/ingestion/prisma-source-run-repository';
import { PrismaWorkTaskRepository } from '@infrastructure/work-tasks/prisma-work-task-repository';
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
  tasks: new PrismaWorkTaskRepository(prisma),
  logger: silentWorkerLogger,
});

const NOW = new Date('2026-05-01T10:00:00.000Z');
const STALE_SECONDS = 3600;
const ACQUISITION_TIMEOUT_MS = 30_000;

/** Fails acquisition, the way an unreachable source does. */
class FailingAdapter extends FakeSourceAdapter {
  override async collect(_context: CollectionContext): Promise<CollectionResult> {
    throw new Error('connection reset by peer');
  }
}

/**
 * Accepts the request and then never answers, the way a wedged source does. Only the
 * acquisition bound can end this run - the adapter itself never settles.
 */
class HangingAdapter extends FakeSourceAdapter {
  override collect(_context: CollectionContext): Promise<CollectionResult> {
    return new Promise<CollectionResult>(() => undefined);
  }
}

/**
 * Finishes its own run underneath the collection, so the collection's finalize finds the
 * run already terminal and discards its outcome - exactly what a reaped stale run does.
 */
class ReapingAdapter extends FakeSourceAdapter {
  override async collect(context: CollectionContext): Promise<CollectionResult> {
    await prisma.sourceRun.update({
      where: { id: context.sourceRunId },
      data: { status: SourceRunStatus.FAILED, finishedAt: NOW, errorSummary: 'lease expired' },
    });
    return {
      records: [],
      catalogueExhausted: false,
      oldestListingPublishedAt: null,
      listingNotNewestFirst: false,
      httpFailures: 0,
    };
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

/** Distinct, promotable records, so a test can control exactly how much the run parses. */
function rows(count: number): RawJobEvidence[] {
  return Array.from({ length: count }, (_, index) =>
    makeRawJob({ sourceJobIdentifier: `yield-${index}`, rawTitle: `Engineer ${index}` }),
  );
}

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  meta?: unknown;
}

function capturingLogger(sink: LogEntry[]): WorkerLogger {
  return {
    info: (message, meta) => sink.push({ level: 'info', message, meta }),
    warn: (message, meta) => sink.push({ level: 'warn', message, meta }),
    error: (message, meta) => sink.push({ level: 'error', message, meta }),
  };
}

/** The same wiring as `collection`, with a logger whose lines the test can read. */
async function runWith(logger: WorkerLogger, adapter: FakeSourceAdapter) {
  return new RunSourceCollection({
    sourceRuns: new PrismaSourceRunRepository(prisma),
    rawJobs: new PrismaRawJobRepository(prisma),
    jobs: new PrismaJobRepository(prisma),
    tasks: new PrismaWorkTaskRepository(prisma),
    logger,
  }).run({
    adapter,
    now: NOW,
    staleRunSeconds: STALE_SECONDS,
    acquisitionTimeoutMs: ACQUISITION_TIMEOUT_MS,
  });
}

/** Prior clean runs, oldest first, as the reduced-yield baseline would read them. */
async function seedCleanRuns(sourceId: string, yields: number[]): Promise<void> {
  const base = new Date('2026-04-01T00:00:00.000Z');
  for (const [index, discovered] of yields.entries()) {
    const at = new Date(base.getTime() + index * 60 * 60_000);
    await prisma.sourceRun.create({
      data: {
        sourceId,
        status: SourceRunStatus.SUCCEEDED,
        startedAt: at,
        finishedAt: at,
        jobsDiscovered: discovered,
        catalogueExhausted: true,
      },
    });
  }
}

/** The fake, but with one record whose selectors broke mid-run. */
class PartlyUnreadableAdapter extends FakeSourceAdapter {
  override async normalize(raw: RawJobEvidence): Promise<NormalizedJob> {
    if (raw.sourceJobIdentifier === 'broken') throw new Error('selectors moved');
    return super.normalize(raw);
  }
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

describe('reduced-yield drift (SRS 7.8)', () => {
  const DRIFT_WARNING = 'source yield collapsed against its recent baseline';

  it('degrades a clean run that yields less than half the recent baseline, and warns', async () => {
    // 20 -> 4 is the shape a broken selector produces: the page still renders, the run
    // still "succeeds", and before this rule the dashboard still said HEALTHY.
    const sourceId = await createSource();
    await seedCleanRuns(sourceId, [20, 20, 18]);
    const logs: LogEntry[] = [];

    const result = await runWith(capturingLogger(logs), adapterFor(sourceId, rows(4)));

    expect(result.status).toBe(SourceRunStatus.SUCCEEDED);
    const source = await healthOf(sourceId);
    expect(source.healthStatus).toBe(HealthStatus.DEGRADED);
    // The run worked. The drop is not an error, and it must not age the success timestamp.
    expect(source.lastErrorAt).toBeNull();
    expect(source.lastSuccessfulRunAt).not.toBeNull();

    const warning = logs.find((entry) => entry.message === DRIFT_WARNING);
    expect(warning?.level).toBe('warn');
    expect(warning?.meta).toMatchObject({ listed: 4, parsed: 4, baselineParsed: 20 });
  });

  it('stays healthy when the yield is within the normal range', async () => {
    const sourceId = await createSource();
    await seedCleanRuns(sourceId, [20, 20, 18]);
    const logs: LogEntry[] = [];

    const result = await runWith(capturingLogger(logs), adapterFor(sourceId, rows(12)));

    expect(result.status).toBe(SourceRunStatus.SUCCEEDED);
    expect((await healthOf(sourceId)).healthStatus).toBe(HealthStatus.HEALTHY);
    expect(logs.some((entry) => entry.message === DRIFT_WARNING)).toBe(false);
  });

  it('does not judge a run that did not read its listing to the end', async () => {
    // A capped run legitimately sees less. Comparing it would turn an incomplete look into
    // evidence about the source, which is the transformation the pipeline forbids.
    const sourceId = await createSource();
    await seedCleanRuns(sourceId, [20, 20, 20]);
    const logs: LogEntry[] = [];
    const capped = new FakeSourceAdapter(makeFakeConfig({ sourceId }), rows(2), false);

    const result = await runWith(capturingLogger(logs), capped);

    expect(result.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(result.run?.catalogueExhausted).toBe(false);
    expect((await healthOf(sourceId)).healthStatus).toBe(HealthStatus.HEALTHY);
    expect(logs.some((entry) => entry.message === DRIFT_WARNING)).toBe(false);
  });

  it('does not judge a partial run by yield, and does not raise the drift warning', async () => {
    const sourceId = await createSource();
    await seedCleanRuns(sourceId, [20, 20, 20]);
    const logs: LogEntry[] = [];
    const broken = new PartlyUnreadableAdapter(makeFakeConfig({ sourceId }), [
      ...rows(2),
      makeRawJob({ sourceJobIdentifier: 'broken', rawTitle: 'Engineer broken' }),
    ]);

    const result = await runWith(capturingLogger(logs), broken);

    // PARTIAL already degrades the source; a second, yield-based verdict would be noise.
    expect(result.status).toBe(SourceRunStatus.PARTIAL);
    expect((await healthOf(sourceId)).healthStatus).toBe(HealthStatus.DEGRADED);
    expect(logs.some((entry) => entry.message === DRIFT_WARNING)).toBe(false);
  });

  it('takes the median of recent runs, so one bad day does not become the norm', async () => {
    // Chronological: 20, 20, then a bad day at 2. The baseline is the median (20), not the
    // latest value (2), otherwise the next collapse would look normal.
    const sourceId = await createSource();
    await seedCleanRuns(sourceId, [20, 20, 2]);

    await runWith(silentWorkerLogger, adapterFor(sourceId, rows(8)));

    expect((await healthOf(sourceId)).healthStatus).toBe(HealthStatus.DEGRADED);
  });
});
