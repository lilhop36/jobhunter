import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SourceRunStatus, SourceRunTrigger, WorkTaskStatus } from '@domain/enums';
import { silentWorkerLogger, type WorkerLogger } from '@ports/worker-logger';
import { SourceScheduler } from '@application/scheduling';
import {
  RunSourceCollection,
  SOURCE_COLLECTION_TASK_TYPE,
  createSourceCollectionHandler,
  sourceCollectionDedupeKey,
} from '@application/ingestion';
import { WorkTaskHandlerRegistry, WorkTaskWorker } from '@application/worker';
import { PrismaJobRepository } from '@infrastructure/ingestion/prisma-job-repository';
import { PrismaJobSourceRepository } from '@infrastructure/ingestion/prisma-job-source-repository';
import { PrismaRawJobRepository } from '@infrastructure/ingestion/prisma-raw-job-repository';
import { PrismaSourceRunRepository } from '@infrastructure/ingestion/prisma-source-run-repository';
import { PrismaWorkTaskRepository } from '@infrastructure/work-tasks/prisma-work-task-repository';
import { FakeSourceAdapter, makeFakeConfig, makeRawJob } from '../support/fake-source-adapter';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * Real-PostgreSQL tests for scheduled collection (FR-002, SRS 7.6).
 *
 * The scheduler is judged on two things:
 *   - it enqueues durable work exactly once per due source, and
 *   - it catches up a run missed while the worker was offline, without back-filling one run
 *     per skipped interval.
 * The last case drives the whole chain (scheduler -> queue -> worker -> handler -> run) so a
 * task type with no registered handler, or a payload the handler rejects, cannot ship green.
 */

const prisma = createTestPrismaClient();
const sourceRuns = new PrismaSourceRunRepository(prisma);
const taskRepo = new PrismaWorkTaskRepository(prisma);
const sourceRepo = new PrismaJobSourceRepository(prisma);
const collection = new RunSourceCollection({
  sourceRuns,
  rawJobs: new PrismaRawJobRepository(prisma),
  jobs: new PrismaJobRepository(prisma),
  tasks: taskRepo,
  logger: silentWorkerLogger,
});

const STALE_SECONDS = 3600;
const ACQUISITION_TIMEOUT_MS = 30_000;
const NOW = new Date();
const MINUTE = 60_000;
const HOUR = 3_600_000;

function makeScheduler(logger: WorkerLogger = silentWorkerLogger): SourceScheduler {
  return new SourceScheduler(
    { sources: sourceRepo, sourceRuns, tasks: taskRepo },
    { staleRunSeconds: STALE_SECONDS },
    logger,
  );
}

/** Collects log calls so a test can assert what an operator would actually see. */
function recordingLogger(): { logger: WorkerLogger; entries: Array<{ level: string; message: string; meta: unknown }> } {
  const entries: Array<{ level: string; message: string; meta: unknown }> = [];
  return {
    entries,
    logger: {
      info: (message, meta) => entries.push({ level: 'info', message, meta }),
      warn: (message, meta) => entries.push({ level: 'warn', message, meta }),
      error: (message, meta) => entries.push({ level: 'error', message, meta }),
    },
  };
}

async function createSource(
  name: string,
  options: { schedule?: string | null; enabled?: boolean } = {},
): Promise<string> {
  const source = await prisma.jobSource.create({
    data: {
      name,
      adapterType: 'FAKE',
      adapterVersion: '1.0.0',
      schedule: options.schedule === undefined ? '1h' : options.schedule,
      enabled: options.enabled ?? true,
    },
  });
  return source.id;
}

/** Record a completed attempt `ageMs` before NOW, so due-ness can be tested without waiting. */
async function recordAttempt(sourceId: string, ageMs: number): Promise<void> {
  await prisma.sourceRun.create({
    data: {
      sourceId,
      status: SourceRunStatus.SUCCEEDED,
      startedAt: new Date(NOW.getTime() - ageMs),
    },
  });
}

function activeTasks(sourceId: string) {
  return prisma.workTask.findMany({ where: { dedupeKey: sourceCollectionDedupeKey(sourceId) } });
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

describe('SourceScheduler due-ness', () => {
  it('enqueues a collection for a source that has never run', async () => {
    const sourceId = await createSource('fresh');

    const result = await makeScheduler().runOnce(NOW, SourceRunTrigger.SCHEDULE);

    expect(result.enqueued).toEqual([sourceId]);
    const tasks = await activeTasks(sourceId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      type: SOURCE_COLLECTION_TASK_TYPE,
      payload: { sourceId, trigger: SourceRunTrigger.SCHEDULE },
    });
  });

  it('does not enqueue while the interval has not elapsed', async () => {
    const sourceId = await createSource('recent', { schedule: '1h' });
    await recordAttempt(sourceId, 10 * MINUTE);

    const result = await makeScheduler().runOnce(NOW, SourceRunTrigger.SCHEDULE);

    expect(result.enqueued).toEqual([]);
    expect(await activeTasks(sourceId)).toHaveLength(0);
  });

  it('enqueues once the interval has elapsed', async () => {
    const sourceId = await createSource('overdue', { schedule: '1h' });
    await recordAttempt(sourceId, HOUR + MINUTE);

    const result = await makeScheduler().runOnce(NOW, SourceRunTrigger.SCHEDULE);

    expect(result.enqueued).toEqual([sourceId]);
    expect(await activeTasks(sourceId)).toHaveLength(1);
  });

  it('never enqueues more than one active task for a source across passes', async () => {
    const sourceId = await createSource('dedupe');
    const scheduler = makeScheduler();

    await scheduler.runOnce(NOW, SourceRunTrigger.STARTUP);
    await scheduler.runOnce(NOW, SourceRunTrigger.SCHEDULE);

    expect(await activeTasks(sourceId)).toHaveLength(1);
  });
});

describe('SourceScheduler skip rules', () => {
  it('skips disabled sources', async () => {
    const sourceId = await createSource('disabled', { enabled: false });
    expect((await makeScheduler().runOnce(NOW)).enqueued).toEqual([]);
    expect(await activeTasks(sourceId)).toHaveLength(0);
  });

  it('skips sources with no schedule', async () => {
    const sourceId = await createSource('unscheduled', { schedule: null });
    expect((await makeScheduler().runOnce(NOW)).enqueued).toEqual([]);
    expect(await activeTasks(sourceId)).toHaveLength(0);
  });

  it('reports an unparseable schedule instead of silently collecting the source', async () => {
    const sourceId = await createSource('broken', { schedule: 'every 6 hours' });
    const { logger, entries } = recordingLogger();

    const result = await makeScheduler(logger).runOnce(NOW);

    expect(result.enqueued).toEqual([]);
    expect(result.invalidSchedules).toEqual([sourceId]);
    expect(await activeTasks(sourceId)).toHaveLength(0);

    // The return value is not the only place it surfaces: an operator sees it as an error,
    // naming the source and the schedule that could not be parsed.
    const reported = entries.find((entry) => entry.message.includes('unparseable schedule'));
    expect(reported?.level).toBe('error');
    expect(reported?.meta).toMatchObject({ sourceId, schedule: 'every 6 hours' });
  });
});

describe('SourceScheduler catch-up (SRS 7.6)', () => {
  it('catches up a run missed while offline exactly once, with the STARTUP trigger', async () => {
    const sourceId = await createSource('missed', { schedule: '1d' });
    // Three days offline: due, but the missed window must not become three runs.
    await recordAttempt(sourceId, 3 * 24 * HOUR);

    const result = await makeScheduler().runOnce(NOW, SourceRunTrigger.STARTUP);

    expect(result.enqueued).toEqual([sourceId]);
    const tasks = await activeTasks(sourceId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload).toMatchObject({ trigger: SourceRunTrigger.STARTUP });
  });

  it('reaps an abandoned run before enqueuing the catch-up', async () => {
    const sourceId = await createSource('wedged', { schedule: '1h' });
    // A run left RUNNING by a dead worker still holds the one-active-run lock.
    const abandoned = await prisma.sourceRun.create({
      data: {
        sourceId,
        status: SourceRunStatus.RUNNING,
        startedAt: new Date(NOW.getTime() - 3 * HOUR),
      },
    });

    const result = await makeScheduler().runOnce(NOW, SourceRunTrigger.STARTUP);

    expect(result.reapedRuns).toBe(1);
    expect(result.enqueued).toEqual([sourceId]);
    const reaped = await prisma.sourceRun.findUnique({ where: { id: abandoned.id } });
    expect(reaped?.status).toBe(SourceRunStatus.FAILED);
  });
});

describe('scheduled collection end to end', () => {
  it('drives scheduler -> queue -> worker -> collection to a recorded run', async () => {
    const sourceId = await createSource('end-to-end');
    const registry = new WorkTaskHandlerRegistry().register(
      SOURCE_COLLECTION_TASK_TYPE,
      createSourceCollectionHandler({
        resolveAdapter: async (id) =>
          new FakeSourceAdapter(makeFakeConfig({ sourceId: id }), [
            makeRawJob({
              sourceJobIdentifier: 'job-1',
              sourceUrl: 'https://example.com/jobs/1',
              rawTitle: 'Backend Engineer',
              rawDescription: 'Build and maintain the collection pipeline. '.repeat(10),
            }),
          ]),
        collection,
        staleRunSeconds: STALE_SECONDS,
        acquisitionTimeoutMs: ACQUISITION_TIMEOUT_MS,
        now: () => NOW,
      }),
    );
    const worker = new WorkTaskWorker(
      taskRepo,
      registry,
      { workerId: 'scheduler-test' },
      silentWorkerLogger,
    );

    await makeScheduler().runOnce(NOW, SourceRunTrigger.STARTUP);
    expect(await worker.runOnce()).toBe(true);

    const run = await prisma.sourceRun.findFirst({ where: { sourceId } });
    expect(run).toMatchObject({
      status: SourceRunStatus.SUCCEEDED,
      trigger: SourceRunTrigger.STARTUP,
      jobsAccepted: 1,
    });
    expect(await prisma.rawJob.count()).toBe(1);
    expect(await prisma.job.count()).toBe(1);

    const tasks = await activeTasks(sourceId);
    expect(tasks[0].status).toBe(WorkTaskStatus.SUCCEEDED);
  });
});
