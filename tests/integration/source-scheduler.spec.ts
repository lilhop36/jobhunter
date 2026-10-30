import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SourceResultExpectation } from '@domain/types';
import { HealthStatus, SourceRunStatus, SourceRunTrigger, WorkTaskStatus } from '@domain/enums';
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

describe('SourceScheduler recovery after a reaped run (H3)', () => {
  /** A run a dead worker left RUNNING, old enough to be reclaimed by the next pass. */
  async function abandonedRun(sourceId: string, ageMs: number): Promise<string> {
    const run = await prisma.sourceRun.create({
      data: {
        sourceId,
        status: SourceRunStatus.RUNNING,
        startedAt: new Date(NOW.getTime() - ageMs),
      },
    });
    return run.id;
  }

  it('re-enqueues a reaped source even though its interval has not elapsed', async () => {
    // The crash happened 3h ago; the schedule is 6h. Reaping frees the source, but its
    // `startedAt` is the last attempt, so due-ness alone would hold it another 3h. A crash
    // near a scheduled run would then silently skip a whole cycle.
    const sourceId = await createSource('crashed', { schedule: '6h' });
    await abandonedRun(sourceId, 3 * HOUR);

    const result = await makeScheduler().runOnce(NOW, SourceRunTrigger.SCHEDULE);

    expect(result.reapedRuns).toBe(1);
    expect(result.enqueued).toEqual([sourceId]);
    const tasks = await activeTasks(sourceId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe(WorkTaskStatus.PENDING);
  });

  it('does not enqueue a recovery for a disabled source', async () => {
    const sourceId = await createSource('crashed-disabled', { schedule: '6h', enabled: false });
    await abandonedRun(sourceId, 3 * HOUR);

    const result = await makeScheduler().runOnce(NOW, SourceRunTrigger.SCHEDULE);

    expect(result.reapedRuns).toBe(1);
    expect(result.enqueued).toEqual([]);
    expect(await activeTasks(sourceId)).toHaveLength(0);
  });

  it('does not duplicate a collection that is already waiting for the same source', async () => {
    const sourceId = await createSource('crashed-deferred', { schedule: '6h' });
    await abandonedRun(sourceId, 3 * HOUR);
    // The crashed task deferred itself and is already queued for the stale-window boundary.
    await taskRepo.enqueue({
      type: SOURCE_COLLECTION_TASK_TYPE,
      payload: { sourceId, trigger: SourceRunTrigger.SCHEDULE },
      dedupeKey: sourceCollectionDedupeKey(sourceId),
    });

    const result = await makeScheduler().runOnce(NOW, SourceRunTrigger.SCHEDULE);

    expect(result.reapedRuns).toBe(1);
    expect(result.enqueued).toEqual([]);
    expect(await activeTasks(sourceId)).toHaveLength(1);
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
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe(WorkTaskStatus.SUCCEEDED);
  });

  it('recovers a source after a crash without waiting for its schedule interval', async () => {
    // The H3 failure in full: a worker dies mid-collection, leaving the run RUNNING and the
    // task claiming. With five fast retries the task used to dead-letter within two minutes,
    // while the run was not reapable for an hour - and the source was not due again for six.
    const sourceId = await createSource('crash-recovery', { schedule: '6h' });
    const crashed = await prisma.sourceRun.create({
      data: {
        sourceId,
        status: SourceRunStatus.RUNNING,
        startedAt: new Date(Date.now() - 10 * MINUTE),
      },
    });
    const task = await taskRepo.enqueue({
      type: SOURCE_COLLECTION_TASK_TYPE,
      payload: { sourceId, trigger: SourceRunTrigger.SCHEDULE },
      dedupeKey: sourceCollectionDedupeKey(sourceId),
    });

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
      { workerId: 'crash-test' },
      silentWorkerLogger,
    );

    // First attempt: the source is still held. The task must be deferred, not failed, and
    // must still be the same task - no attempt burned, no dead letter.
    expect(await worker.runOnce()).toBe(true);
    const deferred = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(deferred.status).toBe(WorkTaskStatus.PENDING);
    expect(deferred.attempts).toBe(0);
    expect(deferred.lastError).toContain('not yet reapable');
    expect((await prisma.sourceRun.findUniqueOrThrow({ where: { id: crashed.id } })).status).toBe(
      SourceRunStatus.RUNNING,
    );

    // The stale window elapses: the abandoned run is now reclaimable, and the deferred task
    // becomes due. Nothing in the scheduler or the interval is involved from here on.
    await prisma.$executeRaw`
      UPDATE "source_runs" SET "startedAt" = (now() AT TIME ZONE 'UTC') - interval '2 hours'
      WHERE "id" = ${crashed.id}::uuid
    `;
    await prisma.$executeRaw`
      UPDATE "work_tasks" SET "runAfter" = (now() AT TIME ZONE 'UTC') - interval '1 second'
      WHERE "id" = ${task.id}::uuid
    `;

    expect(await worker.runOnce()).toBe(true);

    const finished = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(finished.status).toBe(WorkTaskStatus.SUCCEEDED);
    const runs = await prisma.sourceRun.findMany({
      where: { sourceId },
      orderBy: { startedAt: 'asc' },
    });
    expect(runs.map((run) => run.status)).toEqual([
      SourceRunStatus.FAILED, // the abandoned run, reaped by the retry
      SourceRunStatus.SUCCEEDED,
    ]);
    expect(runs[1].jobsAccepted).toBe(1);
  });

  it('reports an empty listing from a source approved to produce results (AC-018)', async () => {
    const sourceId = await createSource('empty-expected');
    const registry = new WorkTaskHandlerRegistry().register(
      SOURCE_COLLECTION_TASK_TYPE,
      createSourceCollectionHandler({
        resolveAdapter: async (id) =>
          new FakeSourceAdapter(
            makeFakeConfig({
              sourceId: id,
              resultExpectation: SourceResultExpectation.RESULTS_EXPECTED,
            }),
            [],
          ),
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

    // The only path that supplies the approval record's expectation is the handler, so this
    // fails if the declaration stops being forwarded: the run would read SUCCEEDED/HEALTHY.
    const run = await prisma.sourceRun.findFirst({ where: { sourceId } });
    expect(run).toMatchObject({
      status: SourceRunStatus.PARTIAL,
      unexpectedZeroResults: true,
      jobsAccepted: 0,
    });
    const source = await prisma.jobSource.findUnique({ where: { id: sourceId } });
    expect(source?.healthStatus).toBe('DEGRADED');
  });
});

/**
 * Silence detection (SRS 7.8; audit H7's open half).
 *
 * Health is written when a run finalizes, so before this rule a source that simply stopped being
 * collected kept its last `HEALTHY` forever and the dashboard showed a green row for a dead
 * source. These tests are the reason the scheduler pass exists as well as the run path: the pass
 * runs every 30 seconds whether or not anything is due, so "nothing arrived for two of your own
 * intervals" is noticed by something.
 */
describe('SourceScheduler silence detection', () => {
  /** A source that was healthy and last delivered `ageMs` before NOW. */
  async function seedHealthySourceAgo(
    name: string,
    ageMs: number,
    healthStatus: HealthStatus = HealthStatus.HEALTHY,
  ): Promise<string> {
    const sourceId = await createSource(name, { schedule: '1h' });
    await prisma.jobSource.update({
      where: { id: sourceId },
      data: {
        healthStatus,
        lastSuccessfulRunAt: new Date(NOW.getTime() - ageMs),
      },
    });
    return sourceId;
  }

  async function healthOf(sourceId: string) {
    return prisma.jobSource.findUnique({
      where: { id: sourceId },
      select: { healthStatus: true, lastSuccessfulRunAt: true, lastErrorAt: true },
    });
  }

  it('degrades a healthy source that has delivered nothing for two of its own intervals', async () => {
    const sourceId = await seedHealthySourceAgo('gone-quiet', 3 * HOUR);
    const { logger, entries } = recordingLogger();

    const result = await makeScheduler(logger).runOnce(NOW, SourceRunTrigger.SCHEDULE);

    expect(result.silentSourceIds).toEqual([sourceId]);
    const health = await healthOf(sourceId);
    expect(health).toMatchObject({ healthStatus: 'DEGRADED' });
    // The age is the finding. Resetting it would erase the evidence, and dating an error would
    // record one that never happened — a run did not fail here; no run happened.
    expect(health?.lastErrorAt).toBeNull();
    expect(health?.lastSuccessfulRunAt?.getTime()).toBe(NOW.getTime() - 3 * HOUR);

    const warning = entries.find((entry) => entry.message === 'source has gone silent');
    expect(warning).toBeDefined();
    expect((warning?.meta as { name: string }).name).toBe('gone-quiet');
    expect(String((warning?.meta as { reason: string }).reason)).toMatch(
      /no successful collection for 3\.0 h/,
    );
  });

  it('says it once: a source already reported silent is not re-stamped or re-logged', async () => {
    const sourceId = await seedHealthySourceAgo('quiet', 3 * HOUR);
    const { logger, entries } = recordingLogger();
    const scheduler = makeScheduler(logger);

    await scheduler.runOnce(NOW, SourceRunTrigger.SCHEDULE);
    const second = await scheduler.runOnce(NOW, SourceRunTrigger.SCHEDULE);

    expect(second.silentSourceIds).toEqual([]);
    expect(entries.filter((entry) => entry.message === 'source has gone silent')).toHaveLength(1);
    expect(await healthOf(sourceId)).toMatchObject({ healthStatus: 'DEGRADED' });
  });

  it('leaves a source that already reports something worse than silence', async () => {
    // A `FAILING` source is silent too, but the failed run says *why*, and silence says nothing
    // about why. Overwriting the truer reason with the vaguer one would lose information.
    const sourceId = await seedHealthySourceAgo('actually-broken', 5 * HOUR, HealthStatus.FAILING);
    const { logger, entries } = recordingLogger();

    const result = await makeScheduler(logger).runOnce(NOW, SourceRunTrigger.SCHEDULE);

    expect(result.silentSourceIds).toEqual([]);
    expect(await healthOf(sourceId)).toMatchObject({ healthStatus: 'FAILING' });
    expect(entries.filter((entry) => entry.message === 'source has gone silent')).toHaveLength(0);
  });

  it('leaves a source that is merely between its own runs', async () => {
    const sourceId = await seedHealthySourceAgo('normal', 90 * MINUTE);
    const { logger, entries } = recordingLogger();

    const result = await makeScheduler(logger).runOnce(NOW, SourceRunTrigger.SCHEDULE);

    expect(result.silentSourceIds).toEqual([]);
    expect(await healthOf(sourceId)).toMatchObject({ healthStatus: 'HEALTHY' });
    expect(entries).toHaveLength(0);
  });

  it('gives no verdict to a source that has never succeeded', async () => {
    // Unknown, not silent: a source that has not yet done anything is not late for it.
    const sourceId = await createSource('brand-new', { schedule: '1h' });
    await prisma.jobSource.update({
      where: { id: sourceId },
      data: { healthStatus: HealthStatus.HEALTHY },
    });

    const result = await makeScheduler().runOnce(NOW, SourceRunTrigger.SCHEDULE);

    expect(result.silentSourceIds).toEqual([]);
    expect(await healthOf(sourceId)).toMatchObject({ healthStatus: 'HEALTHY' });
  });

  it('stamps a source whose last success really is older than the bound, and only once', async () => {
    // The positive control for the fence below: a comparison that always refused would pass it.
    const sourceId = await seedHealthySourceAgo('still-quiet', 3 * HOUR);
    const silentBefore = new Date(NOW.getTime() - 2 * HOUR);

    expect(await sourceRepo.markSourceSilent(sourceId, silentBefore)).toBe(true);
    expect(await healthOf(sourceId)).toMatchObject({ healthStatus: 'DEGRADED' });
    // Same bound again: the row no longer says HEALTHY, so there is nothing left to say.
    expect(await sourceRepo.markSourceSilent(sourceId, silentBefore)).toBe(false);
  });

  it('refuses to stamp a source whose collection succeeded between the reading and the write', async () => {
    // The race the fence exists for: the scheduler decided on a row it had already read, and a run
    // finalized in the meantime. The newer, truer `HEALTHY` must survive.
    const sourceId = await seedHealthySourceAgo('just-recovered', 3 * HOUR);
    await prisma.jobSource.update({
      where: { id: sourceId },
      data: { lastSuccessfulRunAt: new Date(NOW.getTime() - MINUTE) },
    });

    const marked = await sourceRepo.markSourceSilent(sourceId, new Date(NOW.getTime() - 2 * HOUR));

    expect(marked).toBe(false);
    expect(await healthOf(sourceId)).toMatchObject({ healthStatus: 'HEALTHY' });
  });
});
