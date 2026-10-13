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
  BLOCKING_TASK_TYPE,
  KILLED_WORKER_HEARTBEAT_MS,
  KILLED_WORKER_ID,
  KILLED_WORKER_LEASE_SECONDS,
  RECOVERY_WORKER_ID,
} from './support/failure-fixtures';

/**
 * AC-014 / ENG-031: pending work remains recoverable after a worker restart,
 * including an abrupt process kill.
 *
 * The in-process suite can simulate lease expiry, but that cannot distinguish "the
 * owner is slow" from "the owner is gone". This test runs the real worker in a
 * separate process, kills it with SIGKILL while its task is RUNNING, and then
 * shows that a fresh worker recovers the abandoned attempt.
 *
 * Windows has no POSIX signals: `child.kill('SIGKILL')` maps to TerminateProcess.
 * That is precisely the abruptness required here - no cleanup handlers, no
 * graceful shutdown, and therefore no chance to release the lease.
 *
 * Synchronization is on durable database state, never on sleeps.
 */

const prisma = createTestPrismaClient();

const VITE_NODE = join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs');
const VITEST_CONFIG = join(process.cwd(), 'vitest.config.ts');
const CHILD_HARNESS = join(process.cwd(), 'tests', 'failure', 'support', 'worker-child.ts');

/** Matches the NOW_UTC expression in the work-queue repository. */
const DB_NOW_UTC = `date_trunc('milliseconds', now() AT TIME ZONE 'UTC')`;

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

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForTask(
  taskId: string,
  label: string,
  predicate: (row: TaskRow) => boolean,
  timeoutMs = 20_000,
): Promise<TaskRow> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskRow | undefined;
  while (Date.now() < deadline) {
    last = await readTask(taskId);
    if (predicate(last)) return last;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}; last state: ${JSON.stringify(last)}`);
}

function startChildWorker(): {
  proc: ChildProcess;
  exited: Promise<ChildExit>;
  diagnostics: () => string;
} {
  const log: string[] = [];
  const proc = spawn(
    process.execPath,
    [VITE_NODE, '--config', VITEST_CONFIG, CHILD_HARNESS],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_DATABASE_URL: requireTestDatabaseUrl(),
        FAILURE_WORKER_ID: KILLED_WORKER_ID,
        FAILURE_LEASE_SECONDS: String(KILLED_WORKER_LEASE_SECONDS),
        FAILURE_HEARTBEAT_MS: String(KILLED_WORKER_HEARTBEAT_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

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

async function waitForKilledWorkerClaim(
  taskId: string,
  proc: ChildProcess,
  diagnostics: () => string,
): Promise<TaskRow> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const row = await readTask(taskId);
    if (row.status === 'RUNNING' && row.leaseToken !== null && row.lockedBy === KILLED_WORKER_ID) {
      return row;
    }
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `worker child exited before claiming the task (code=${String(proc.exitCode)}, signal=${String(proc.signalCode)})\n${diagnostics()}`,
      );
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for the child worker to claim the task\n${diagnostics()}`);
}

async function isLeaseExpired(taskId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ expired: boolean }>>`
    SELECT ("leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" < ${Prisma.raw(DB_NOW_UTC)}) AS "expired"
    FROM "work_tasks"
    WHERE "id" = ${taskId}::uuid
  `;
  return rows[0]?.expired === true;
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

describe('worker restart after an abrupt process kill (AC-014)', () => {
  it(
    'recovers a task abandoned by a SIGKILLed worker and re-runs it to SUCCEEDED',
    async () => {
      const repo = new PrismaWorkTaskRepository(prisma);
      const enqueued = await repo.enqueue({ type: BLOCKING_TASK_TYPE });

      const started = startChildWorker();
      child = started.proc;

      const claimed = await waitForKilledWorkerClaim(
        enqueued.id,
        started.proc,
        started.diagnostics,
      );
      expect(claimed.attempts).toBe(1);
      expect(claimed.status).toBe('RUNNING');

      // Abrupt kill: no graceful shutdown, so the lease is never released.
      started.proc.kill('SIGKILL');
      const exit = await started.exited;
      expect(exit.signal ?? null, `child diagnostics:\n${started.diagnostics()}`).not.toBeNull();

      // The abandoned attempt is still RUNNING and still owned by the dead
      // worker: work was not lost, but it is wedged until the lease lapses.
      const afterCrash = await readTask(enqueued.id);
      expect(afterCrash.status).toBe('RUNNING');
      expect(afterCrash.leaseToken).toBe(claimed.leaseToken);
      expect(afterCrash.lockedBy).toBe(KILLED_WORKER_ID);
      expect(afterCrash.finishedAt).toBeNull();

      // Wait for genuine time-based expiry, evaluated on the database clock.
      await waitFor('the abandoned lease to expire', () => isLeaseExpired(enqueued.id));

      const recovery = new WorkTaskWorker(
        new PrismaWorkTaskRepository(prisma),
        new WorkTaskHandlerRegistry().register(BLOCKING_TASK_TYPE, async () => {}),
        {
          workerId: RECOVERY_WORKER_ID,
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
          'the recovery worker to finish the task',
          (row) => row.status !== 'RUNNING' && row.status !== 'PENDING',
        );

        expect(recovered.status).toBe('SUCCEEDED');
        // ENG-024: the aborted attempt consumed an attempt, and the recovery is
        // genuinely a second execution.
        expect(recovered.attempts).toBe(2);
        expect(recovered.lockedBy).toBe(RECOVERY_WORKER_ID);
        expect(recovered.finishedAt).not.toBeNull();
        // ENG-025: recovery happened through lease reaping, not by accident.
        expect(recovered.lastError).toContain('lease expired');
      } finally {
        await recovery.stop();
      }
    },
    60_000,
  );
});
