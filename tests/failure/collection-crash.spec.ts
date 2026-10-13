import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { WorkTaskHandlerRegistry, WorkTaskWorker } from '@application/worker';
import { PrismaWorkTaskRepository } from '@infrastructure/work-tasks/prisma-work-task-repository';
import { silentWorkerLogger } from '@ports/worker-logger';
import {
  applyTestMigrations,
  createTestPrismaClient,
  requireTestDatabaseUrl,
  truncateAll,
} from '../support/db';
import {
  COLLECTION_BLOCKING_IDENTIFIER,
  COLLECTION_KILLED_WORKER_ID,
  COLLECTION_RECOVERY_WORKER_ID,
  COLLECTION_TASK_TYPE,
  collectionRecords,
  collectionTaskPayload,
  createCollectionHandler,
} from './support/collection-fixtures';
import {
  KILLED_WORKER_HEARTBEAT_MS,
  KILLED_WORKER_LEASE_SECONDS,
} from './support/failure-fixtures';

/**
 * A collection killed mid-run must leave evidence intact and be recoverable, and the
 * retry must not duplicate observations or Jobs.
 *
 * The in-process suite can show that a stale run is reaped, but it cannot show what a
 * genuinely abrupt death leaves behind. This test therefore runs the REAL worker and the
 * REAL `RunSourceCollection` in a separate process and kills it with SIGKILL at a
 * deterministic point inside the record loop.
 *
 * The kill point is chosen so the durable state is unambiguous rather than timing-based:
 * raw evidence is written before `normalize` is entered (SRS 7.7 step 4 precedes step 5),
 * so when the child is blocked normalizing the third record the database must show
 * exactly 3 raw captures and 2 Jobs, with the run still RUNNING. Synchronization is on
 * that durable state evaluated on the database clock - never on a sleep.
 *
 * Windows has no POSIX signals: `child.kill('SIGKILL')` maps to TerminateProcess, which is
 * precisely the abruptness required (no cleanup handlers, so nothing releases the run).
 */

const prisma = createTestPrismaClient();

const VITE_NODE = join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs');
const VITEST_CONFIG = join(process.cwd(), 'vitest.config.ts');
const CHILD_HARNESS = join(process.cwd(), 'tests', 'failure', 'support', 'collection-child.ts');

/** Matches the NOW_UTC expression in the ingestion repositories. */
const DB_NOW_UTC = `date_trunc('milliseconds', now() AT TIME ZONE 'UTC')`;

const EXPECTED_RECORDS = collectionRecords().length;

interface TaskRow {
  status: string;
  attempts: number;
  leaseToken: string | null;
  lockedBy: string | null;
  lastError: string | null;
  finishedAt: Date | null;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

let child: ChildProcess | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function readTask(taskId: string): Promise<TaskRow> {
  const rows = await prisma.$queryRaw<TaskRow[]>`
    SELECT "status"::text AS "status",
           "attempts",
           "leaseToken",
           "lockedBy",
           "lastError",
           "finishedAt"
    FROM "work_tasks"
    WHERE "id" = ${taskId}::uuid
  `;
  if (rows.length !== 1) throw new Error(`work task ${taskId} not found`);
  return rows[0];
}

async function waitForTask(
  taskId: string,
  label: string,
  predicate: (row: TaskRow) => boolean,
): Promise<TaskRow> {
  const deadline = Date.now() + 30_000;
  let last: TaskRow | undefined;
  while (Date.now() < deadline) {
    last = await readTask(taskId);
    if (predicate(last)) return last;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}; last state: ${JSON.stringify(last)}`);
}

function countRawJobs(sourceId: string): Promise<number> {
  return prisma.rawJob.count({ where: { sourceId } });
}

function countJobs(sourceId: string): Promise<number> {
  return prisma.job.count({ where: { sourceId } });
}

async function isSourceRunStale(runId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ stale: boolean }>>`
    SELECT (${Prisma.raw(DB_NOW_UTC)} - "startedAt" > interval '1 second') AS "stale"
    FROM "source_runs"
    WHERE "id" = ${runId}::uuid
  `;
  return rows[0]?.stale === true;
}

async function isTaskLeaseExpired(taskId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ expired: boolean }>>`
    SELECT ("leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" < ${Prisma.raw(DB_NOW_UTC)}) AS "expired"
    FROM "work_tasks"
    WHERE "id" = ${taskId}::uuid
  `;
  return rows[0]?.expired === true;
}

function startChildWorker(): {
  proc: ChildProcess;
  exited: Promise<ChildExit>;
  diagnostics: () => string;
} {
  const log: string[] = [];
  const proc = spawn(process.execPath, [VITE_NODE, '--config', VITEST_CONFIG, CHILD_HARNESS], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TEST_DATABASE_URL: requireTestDatabaseUrl(),
      FAILURE_WORKER_ID: COLLECTION_KILLED_WORKER_ID,
      FAILURE_LEASE_SECONDS: String(KILLED_WORKER_LEASE_SECONDS),
      FAILURE_HEARTBEAT_MS: String(KILLED_WORKER_HEARTBEAT_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const capture = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    log.push(`[${stream}] ${chunk.toString().trimEnd()}`);
  };
  proc.stdout?.on('data', capture('stdout'));
  proc.stderr?.on('data', capture('stderr'));

  const exited = new Promise<ChildExit>((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return { proc, exited, diagnostics: () => (log.length ? log.join('\n') : '(no child output)') };
}

/**
 * Waits for the deterministic mid-collection state: the run is open, raw evidence for
 * three records is recorded (the third written before its normalization blocked), and
 * two Jobs have been promoted.
 */
async function waitForCollectionInProgress(
  sourceId: string,
  proc: ChildProcess,
  diagnostics: () => string,
): Promise<{ runId: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const runs = await prisma.sourceRun.findMany({ where: { sourceId } });
    if (
      runs.length === 1 &&
      runs[0].status === 'RUNNING' &&
      (await countRawJobs(sourceId)) === 3 &&
      (await countJobs(sourceId)) === 2
    ) {
      return { runId: runs[0].id };
    }
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `child exited before reaching mid-collection (code=${String(proc.exitCode)}, signal=${String(proc.signalCode)})\n${diagnostics()}`,
      );
    }
    await delay(50);
  }
  throw new Error(
    `timed out waiting for mid-collection state (run=${String(
      (await prisma.sourceRun.findMany({ where: { sourceId } })).length,
    )}, raw=${String(await countRawJobs(sourceId))}, jobs=${String(await countJobs(sourceId))})\n${diagnostics()}`,
  );
}

beforeAll(() => {
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

afterEach(async () => {
  const proc = child;
  child = null;
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGKILL');
    await Promise.race([
      new Promise<void>((resolve) => proc.once('exit', () => resolve())),
      delay(5_000),
    ]);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('collection crash recovery', () => {
  it(
    'preserves partial evidence, then recovers through lease reaping without duplicating rows',
    async () => {
      const source = await prisma.jobSource.create({
        data: { name: 'collection-crash', adapterType: 'FAKE', adapterVersion: '1.0.0' },
      });
      const sourceId = source.id;
      const enqueued = await new PrismaWorkTaskRepository(prisma).enqueue({
        type: COLLECTION_TASK_TYPE,
        payload: collectionTaskPayload(sourceId),
      });

      const started = startChildWorker();
      child = started.proc;
      const abandoned = await waitForCollectionInProgress(
        sourceId,
        started.proc,
        started.diagnostics,
      );

      // Abrupt kill: no graceful shutdown, so neither the run nor the lease is released.
      started.proc.kill('SIGKILL');
      const exit = await started.exited;
      expect(exit.signal ?? null, `child diagnostics:\n${started.diagnostics()}`).not.toBeNull();

      // What the crash left behind: the run is still RUNNING (wedged, not finished) and
      // the evidence already collected is durable. Nothing was lost and nothing
      // pretended to finish.
      const crashedRun = await prisma.sourceRun.findUniqueOrThrow({
        where: { id: abandoned.runId },
      });
      expect(crashedRun.status).toBe('RUNNING');
      expect(crashedRun.finishedAt).toBeNull();

      const crashedTask = await readTask(enqueued.id);
      expect(crashedTask.status).toBe('RUNNING');
      expect(crashedTask.lockedBy).toBe(COLLECTION_KILLED_WORKER_ID);
      expect(crashedTask.finishedAt).toBeNull();

      expect(await countRawJobs(sourceId)).toBe(3);
      expect(await countJobs(sourceId)).toBe(2);

      // The record whose normalization never returned had its raw evidence written
      // before the block, so the crash did not lose it (SRS 7.7 step 4 ordering).
      const persistedIdentifiers = (
        await prisma.rawJob.findMany({ where: { sourceId }, select: { sourceJobIdentifier: true } })
      ).map((row) => row.sourceJobIdentifier);
      expect(persistedIdentifiers).toContain(COLLECTION_BLOCKING_IDENTIFIER);

      // ...but it was rightly not promoted: its Job was never written.
      const promotedKeys = (
        await prisma.job.findMany({ where: { sourceId }, select: { identityKey: true } })
      ).map((row) => row.identityKey);
      expect(promotedKeys).not.toContain(`sid:${COLLECTION_BLOCKING_IDENTIFIER}`);

      // Wait for genuine time-based recovery preconditions, both on the database clock:
      // the abandoned run exceeds its safety bound, and the dead worker's lease lapses.
      await waitFor('the abandoned source run to exceed its safety bound', () =>
        isSourceRunStale(abandoned.runId),
      );
      await waitFor('the abandoned task lease to expire', () => isTaskLeaseExpired(enqueued.id));

      const recovery = new WorkTaskWorker(
        new PrismaWorkTaskRepository(prisma),
        new WorkTaskHandlerRegistry().register(
          COLLECTION_TASK_TYPE,
          // No block: the recovery run must be able to finish.
          createCollectionHandler(prisma, null),
        ),
        {
          workerId: COLLECTION_RECOVERY_WORKER_ID,
          leaseSeconds: 30,
          heartbeatIntervalMs: 5_000,
          pollIntervalMs: 50,
          reaperIntervalMs: 50,
          shutdownTimeoutMs: 2_000,
        },
        silentWorkerLogger,
      );

      try {
        await recovery.start();
        const recovered = await waitForTask(
          enqueued.id,
          'the recovery worker to finish the collection',
          (row) => row.status !== 'RUNNING' && row.status !== 'PENDING',
        );

        expect(recovered.status).toBe('SUCCEEDED');
        expect(recovered.attempts).toBe(2);
        expect(recovered.lockedBy).toBe(COLLECTION_RECOVERY_WORKER_ID);
        expect(recovered.finishedAt).not.toBeNull();
        // Recovery happened through lease reaping, not by accident (ENG-025).
        expect(recovered.lastError).toContain('lease expired');
      } finally {
        await recovery.stop();
      }

      // The abandoned run was finalized by the reaper, not left RUNNING.
      const reapedRun = await prisma.sourceRun.findUniqueOrThrow({ where: { id: abandoned.runId } });
      expect(reapedRun.status).toBe('FAILED');
      expect(reapedRun.errorSummary).toBe('LEASE_EXPIRED');
      expect(reapedRun.finishedAt).not.toBeNull();

      // Retry semantics: exactly one further run, and it completed with a funnel that
      // accounts for the records the crashed attempt had already promoted.
      const runs = await prisma.sourceRun.findMany({
        where: { sourceId },
        orderBy: { startedAt: 'asc' },
      });
      expect(runs).toHaveLength(2);
      expect(runs[1].status).toBe('SUCCEEDED');
      expect(runs[1]).toMatchObject({
        jobsDiscovered: EXPECTED_RECORDS,
        jobsAccepted: 2,
        jobsDuplicate: 2,
        jobsRejected: 0,
        undeduplicable: 0,
        fallbackIdentities: 0,
        parseFailures: 0,
        httpFailures: 0,
      });

      // No duplicated evidence and no duplicated Jobs, despite the partial first attempt.
      expect(await countRawJobs(sourceId)).toBe(EXPECTED_RECORDS);
      expect(await countJobs(sourceId)).toBe(EXPECTED_RECORDS);
    },
    120_000,
  );
});
