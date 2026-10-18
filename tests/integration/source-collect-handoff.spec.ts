import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { SOURCE_COLLECTION_TASK_TYPE, sourceCollectionDedupeKey } from '@application/ingestion';
import { SourceRunStatus, SourceRunTrigger } from '@domain/enums';
import { buildApi } from '../../apps/api/main';
import { parseApiConfig } from '../../apps/api/config';
import { createWorkerRuntime, type WorkerRuntime } from '../../apps/worker/runtime';
import type { WorkerConfig } from '../../apps/worker/config';
import {
  applyTestMigrations,
  createTestPrismaClient,
  requireTestDatabaseUrl,
  truncateAll,
} from '../support/db';
import { FakeSourceAdapter, makeFakeConfig, makeRawJob } from '../support/fake-source-adapter';

/**
 * The manual-run handoff: `POST /api/sources/:id/run` to a finished collection (SRS 3.4,
 * 7.5, 7.7).
 *
 * The API and the worker exchange one thing, a queue row, and neither imports the other. So
 * the only way to know the exchange still works is to run both: the API is started with
 * `buildApi` and driven through its real endpoint, the worker with `createWorkerRuntime` and
 * its real registry, worker loop and collection handler. A change to the task type, the
 * dedupe key, the payload shape or the trigger would break this test and nothing else.
 *
 * No real source adapter is exercised by this test - its source name matches no
 * registration, so the production `resolveAdapter` returns null exactly as an
 * unapproved source must. The approved-source path (EffoySira) is covered end to end by
 * `effoysira-source-collection.spec.ts`.
 */

const prisma = createTestPrismaClient();
let app: FastifyInstance;
let appPrisma: PrismaClient;
let runtime: WorkerRuntime | undefined;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);
  const api = await buildApi(
    parseApiConfig({
      ...process.env,
      DATABASE_URL: requireTestDatabaseUrl(),
      API_HOST: '127.0.0.1',
    }),
  );
  app = api.app;
  appPrisma = api.prisma;
  await app.ready();
});

afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
  await app.close();
  await appPrisma.$disconnect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function workerConfig(): WorkerConfig {
  return {
    databaseUrl: requireTestDatabaseUrl(),
    workerId: 'handoff-worker',
    leaseSeconds: 30,
    pollIntervalMs: 25,
    // The reaper and the scheduler are not what this test is about, and 60s keeps both out
    // of the way without switching them off.
    reaperIntervalMs: 60_000,
    schedulerIntervalMs: 60_000,
    staleRunSeconds: 5,
    acquisitionTimeoutMs: 1_000,
  };
}

async function waitForText(
  read: () => Promise<string>,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await read();
    if (last !== '') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}; last state: ${JSON.stringify(last)}`);
}

async function waitForTask(taskId: string): Promise<string> {
  let status = '';
  await waitForText(async () => {
    const task = await prisma.workTask.findUniqueOrThrow({ where: { id: taskId } });
    status = task.status;
    return status === 'SUCCEEDED' || status === 'FAILED' || status === 'DEAD_LETTER'
      ? status
      : '';
  }, 'the enqueued collection task to be claimed');
  return status;
}

describe('manual run handoff', () => {
  it('carries the API enqueue to the registered collection handler', async () => {
    const source = await prisma.jobSource.create({
      data: { name: 'handoff-source', adapterType: 'FAKE', adapterVersion: '1.0.0' },
    });
    const rows = [
      makeRawJob({ sourceJobIdentifier: 'h-1', rawTitle: 'Backend Engineer', rawCompany: 'Acme' }),
      makeRawJob({ sourceJobIdentifier: 'h-2', rawTitle: 'Data Analyst', rawCompany: 'Acme' }),
    ];

    const response = await app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/run`,
    });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { task: { id: string; type: string } };
    expect(response.headers['content-type']).toContain('application/json');

    // The task the API queued is the task the worker's registry consumes: same type, and a
    // dedupe key that matches the one the scheduler uses, so a manual run and a scheduled run
    // can never both hold the source.
    expect(response.json().task.type).toBe(SOURCE_COLLECTION_TASK_TYPE);
    const enqueued = await prisma.workTask.findUniqueOrThrow({
      where: { id: response.json().task.id },
    });
    expect(enqueued.type).toBe(SOURCE_COLLECTION_TASK_TYPE);
    expect(enqueued.dedupeKey).toBe(sourceCollectionDedupeKey(source.id));
    expect(enqueued.payload).toEqual({ sourceId: source.id, trigger: SourceRunTrigger.MANUAL });

    runtime = createWorkerRuntime(workerConfig(), {
      resolveAdapter: async (requested) =>
        requested === source.id
          ? new FakeSourceAdapter(makeFakeConfig({ sourceId: source.id }), rows)
          : null,
    });
    await runtime.start();

    expect(await waitForTask(enqueued.id)).toBe('SUCCEEDED');

    const runs = await prisma.sourceRun.findMany({ where: { sourceId: source.id } });
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.trigger).toBe(SourceRunTrigger.MANUAL);
    expect(run.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(run.jobsDiscovered).toBe(2);
    expect(run.jobsAccepted).toBe(2);
    expect(run.jobsDuplicate).toBe(0);

    // The collection actually persisted what the handler was given, so SUCCEEDED is not just
    // a terminal status with nothing behind it.
    expect(await prisma.rawJob.count({ where: { sourceId: source.id } })).toBe(2);
    expect(await prisma.job.count({ where: { sourceId: source.id } })).toBe(2);
  }, 60_000);
});
