import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { SOURCE_COLLECTION_TASK_TYPE, sourceCollectionDedupeKey } from '@application/ingestion';
import { HealthStatus } from '@domain/enums';
import { PrismaWorkTaskRepository } from '@infrastructure/work-tasks/prisma-work-task-repository';
import {
  applyTestMigrations,
  createTestPrismaClient,
  requireTestDatabaseUrl,
  truncateAll,
} from '../support/db';
import {
  COLLECTION_ACQUISITION_TIMEOUT_MS,
  COLLECTION_BLOCKING_IDENTIFIER,
  COLLECTION_KILLED_WORKER_ID,
  COLLECTION_RECOVERY_WORKER_ID,
  COLLECTION_STALE_RUN_SECONDS,
  collectionRecords,
  collectionTaskPayload,
} from './support/collection-fixtures';
import {
  KILLED_WORKER_HEARTBEAT_MS,
  KILLED_WORKER_LEASE_SECONDS,
} from './support/failure-fixtures';

/**
 * A collection killed mid-run must leave evidence intact and be recoverable, and the retry
 * must not duplicate observations or Jobs (AC-014).
 *
 * The in-process suite can show that a stale run is reaped, but it cannot show what a
 * genuinely abrupt death leaves behind. This test therefore starts the REAL worker entry
 * point as a separate process - `tests/failure/support/worker-entry.ts`, which is the
 * production composition root with a test adapter registered - and kills it with SIGKILL
 * at a deterministic point inside the record loop. A second real entry-point process is
 * then started, exactly as an operator would restart a crashed worker, and it must recover
 * the abandoned work on its own.
 *
 * Driving the entry point rather than a hand-assembled worker is the point: a handler that
 * was never registered, a scheduler that was never started, or a config bound that was
 * ignored would all pass against a harness that wires itself up.
 *
 * The kill point is chosen so the durable state is unambiguous rather than timing-based:
 * raw evidence is written before `normalize` is entered (SRS 7.7 step 4 precedes step 5),
 * so when the worker is blocked normalizing the third record the database must show exactly
 * 3 raw captures and 2 Jobs, with the run still RUNNING. Synchronization is on that durable
 * state evaluated on the database clock - never on a sleep.
 *
 * Windows has no POSIX signals: `child.kill('SIGKILL')` maps to TerminateProcess, which is
 * precisely the abruptness required (no cleanup handlers, so nothing releases the run).
 */

const prisma = createTestPrismaClient();

const VITE_NODE = join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs');
const VITEST_CONFIG = join(process.cwd(), 'vitest.config.ts');
const ENTRY_POINT = join(process.cwd(), 'tests', 'failure', 'support', 'worker-entry.ts');

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

interface StartedWorker {
  proc: ChildProcess;
  /** Everything the child printed, for failure messages. */
  diagnostics: () => string;
}

const children: ChildProcess[] = [];

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
  worker: StartedWorker,
): Promise<TaskRow> {
  const deadline = Date.now() + 30_000;
  let last: TaskRow | undefined;
  while (Date.now() < deadline) {
    last = await readTask(taskId);
    if (predicate(last)) return last;
    if (worker.proc.exitCode !== null || procSignal(worker.proc) !== null) {
      throw new Error(
        `the worker exited before ${label} (code=${String(worker.proc.exitCode)})\n${worker.diagnostics()}`,
      );
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}; last state: ${JSON.stringify(last)}`);
}

function procSignal(proc: ChildProcess): NodeJS.Signals | null {
  return proc.signalCode;
}

function countRawJobs(sourceId: string): Promise<number> {
  return prisma.rawJob.count({ where: { sourceId } });
}

function countJobs(sourceId: string): Promise<number> {
  return prisma.job.count({ where: { sourceId } });
}

async function isSourceRunStale(runId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ stale: boolean }>>`
    SELECT (${Prisma.raw(DB_NOW_UTC)} - "startedAt") > (${COLLECTION_STALE_RUN_SECONDS} * interval '1 second') AS "stale"
    FROM "source_runs"
    WHERE "id" = ${runId}::uuid
  `;
  return rows.length === 1 && rows[0].stale;
}

async function isTaskLeaseExpired(taskId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ expired: boolean }>>`
    SELECT ("status" = 'RUNNING' AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" < ${Prisma.raw(DB_NOW_UTC)}) AS "expired"
    FROM "work_tasks"
    WHERE "id" = ${taskId}::uuid
  `;
  return rows.length === 1 && rows[0].expired;
}

/**
 * Start the real worker entry point as its own process.
 *
 * Every value the entry parses comes from the environment, exactly as in production; only
 * the adapter (through `FAILURE_SOURCE_ID`/`FAILURE_BLOCK_ON`) is a test concern.
 */
function startEntryWorker(task: {
  workerId: string;
  sourceId: string;
  leaseSeconds: number;
  heartbeatMs: number;
  /** Identifier whose normalization never settles. Omitted, the worker can finish. */
  blockOn?: string;
}): StartedWorker {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TEST_DATABASE_URL: requireTestDatabaseUrl(),
    WORKER_ID: task.workerId,
    WORKER_LEASE_SECONDS: String(task.leaseSeconds),
    WORKER_HEARTBEAT_MS: String(task.heartbeatMs),
    WORKER_POLL_INTERVAL_MS: '50',
    WORKER_REAPER_INTERVAL_MS: '50',
    SOURCE_STALE_RUN_SECONDS: String(COLLECTION_STALE_RUN_SECONDS),
    SOURCE_ACQUISITION_TIMEOUT_MS: String(COLLECTION_ACQUISITION_TIMEOUT_MS),
    FAILURE_SOURCE_ID: task.sourceId,
  };
  if (task.blockOn !== undefined) env.FAILURE_BLOCK_ON = task.blockOn;

  const proc = spawn(process.execPath, [VITE_NODE, '--config', VITEST_CONFIG, ENTRY_POINT], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log: string[] = [];
  const capture = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    log.push(`[${stream}] ${chunk.toString().trimEnd()}`);
  };
  proc.stdout?.on('data', capture('stdout'));
  proc.stderr?.on('data', capture('stderr'));

  children.push(proc);
  return {
    proc,
    diagnostics: () => (log.length === 0 ? '(the worker printed nothing)' : log.join('\n')),
  };
}

/** Kill a worker outright and wait for the process to be gone, so the DB state is final. */
async function killOutright(worker: StartedWorker): Promise<void> {
  worker.proc.kill('SIGKILL');
  await Promise.race([
    new Promise<void>((resolve) => worker.proc.once('exit', () => resolve())),
    delay(10_000),
  ]);
}

async function waitForCollectionInProgress(
  sourceId: string,
  worker: StartedWorker,
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
    if (worker.proc.exitCode !== null || worker.proc.signalCode !== null) {
      throw new Error(
        `the worker exited before reaching mid-collection (code=${String(worker.proc.exitCode)}, signal=${String(worker.proc.signalCode)})\n${worker.diagnostics()}`,
      );
    }
    await delay(50);
  }
  throw new Error(
    `timed out waiting for mid-collection state (runs=${String(
      (await prisma.sourceRun.findMany({ where: { sourceId } })).length,
    )}, raw=${String(await countRawJobs(sourceId))}, jobs=${String(await countJobs(sourceId))})\n${worker.diagnostics()}`,
  );
}

beforeAll(() => {
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

afterEach(async () => {
  const running = children.splice(0, children.length);
  for (const proc of running) {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
    }
  }
  await Promise.all(
    running.map((proc) =>
      Promise.race([
        new Promise<void>((resolve) => proc.once('exit', () => resolve())),
        delay(5_000),
      ]),
    ),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('collection crash recovery through the real worker entry point', () => {
  it(
    'preserves partial evidence, then recovers through lease reaping without duplicating rows',
    async () => {
      const source = await prisma.jobSource.create({
        data: { name: 'collection-crash', adapterType: 'FAKE', adapterVersion: '1.0.0' },
      });
      const sourceId = source.id;
      const enqueued = await new PrismaWorkTaskRepository(prisma).enqueue({
        type: SOURCE_COLLECTION_TASK_TYPE,
        payload: collectionTaskPayload(sourceId),
        dedupeKey: sourceCollectionDedupeKey(sourceId),
      });

      const crashed = startEntryWorker({
        workerId: COLLECTION_KILLED_WORKER_ID,
        sourceId,
        leaseSeconds: KILLED_WORKER_LEASE_SECONDS,
        heartbeatMs: KILLED_WORKER_HEARTBEAT_MS,
        blockOn: COLLECTION_BLOCKING_IDENTIFIER,
      });

      const abandoned = await waitForCollectionInProgress(sourceId, crashed);
      await killOutright(crashed);

      // What the abrupt death left behind: the run is still RUNNING and the evidence
      // written so far is durable. Nothing was lost, and nothing pretended to finish.
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

      // The record whose normalization never returned had its raw evidence written before
      // the block, so the crash did not lose it (SRS 7.7 step 4 ordering).
      const persistedIdentifiers = (
        await prisma.rawJob.findMany({ where: { sourceId }, select: { sourceJobIdentifier: true } })
      ).map((row) => row.sourceJobIdentifier);
      expect(persistedIdentifiers).toContain(COLLECTION_BLOCKING_IDENTIFIER);

      // ...but it was rightly not promoted: its Job was never written.
      const promotedKeys = (
        await prisma.job.findMany({ where: { sourceId }, select: { identityKey: true } })
      ).map((row) => row.identityKey);
      expect(promotedKeys).not.toContain(`sid:${COLLECTION_BLOCKING_IDENTIFIER}`);

      // Wait for genuine time-based recovery preconditions, both on the database clock: the
      // abandoned run exceeds its safety bound, and the dead worker's lease lapses.
      await waitFor('the abandoned source run to exceed its safety bound', () =>
        isSourceRunStale(abandoned.runId),
      );
      await waitFor('the abandoned task lease to expire', () => isTaskLeaseExpired(enqueued.id));

      // Restart: a fresh entry-point process, with no knowledge of the crash, must recover
      // the work on its own through its startup reaper and lease reaping (ENG-025).
      const restarted = startEntryWorker({
        workerId: COLLECTION_RECOVERY_WORKER_ID,
        sourceId,
        leaseSeconds: 30,
        heartbeatMs: 5_000,
      });

      const recovered = await waitForTask(
        enqueued.id,
        'the restarted worker to finish the collection',
        (row) => row.status !== 'RUNNING' && row.status !== 'PENDING',
        restarted,
      );

      expect(recovered.status).toBe('SUCCEEDED');
      expect(recovered.attempts).toBe(2);
      expect(recovered.lockedBy).toBe(COLLECTION_RECOVERY_WORKER_ID);
      expect(recovered.finishedAt).not.toBeNull();
      // Recovery happened through lease reaping, not by accident (ENG-025).
      expect(recovered.lastError).toContain('lease expired');

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

      // FR-020: the reaped run is not evidence about the source, so only the successful
      // retry moved health - and it moved it to exactly the instant that run finished.
      const health = await prisma.jobSource.findUniqueOrThrow({ where: { id: sourceId } });
      expect(health.healthStatus).toBe(HealthStatus.HEALTHY);
      expect(health.lastSuccessfulRunAt).toEqual(runs[1].finishedAt);
    },
    120_000,
  );
});
