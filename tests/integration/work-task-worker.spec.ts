import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  PermanentWorkTaskError,
  RetryableWorkTaskError,
  WorkTaskHandlerRegistry,
  WorkTaskWorker,
} from '@application/worker';
import { PrismaWorkTaskRepository } from '@infrastructure/work-tasks/prisma-work-task-repository';
import { silentWorkerLogger } from '@ports/worker-logger';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * Real-PostgreSQL tests for the generic worker: dispatch, heartbeats, retry
 * integration, expired-lease recovery and graceful shutdown. The worker owns no
 * retry policy, so these tests also verify that terminal decisions come from the
 * repository given only a retryable/permanent classification.
 */

const prisma = createTestPrismaClient();
let intruder: PrismaClient;

const repo = new PrismaWorkTaskRepository(prisma);
// Immediate retries so retry integration never waits on backoff.
const immediate = new PrismaWorkTaskRepository(prisma, {
  backoff: { baseSeconds: 0, factor: 2, maxSeconds: 0 },
});

let intruderRepo: PrismaWorkTaskRepository;

function buildWorker(
  handlers: WorkTaskHandlerRegistry,
  overrides: Partial<ConstructorParameters<typeof WorkTaskWorker>[2]> = {},
): WorkTaskWorker {
  return new WorkTaskWorker(
    repo,
    handlers,
    {
      workerId: 'test-worker',
      leaseSeconds: 60,
      heartbeatIntervalMs: 10_000,
      pollIntervalMs: 5,
      reaperIntervalMs: 5,
      shutdownTimeoutMs: 2000,
      ...overrides,
    },
    silentWorkerLogger,
  );
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

async function expireLease(taskId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "work_tasks"
    SET "leaseExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'
    WHERE "id" = ${taskId}::uuid
  `;
}

beforeAll(() => {
  applyTestMigrations();
  intruder = createTestPrismaClient();
  intruderRepo = new PrismaWorkTaskRepository(intruder);
});

beforeEach(async () => {
  await truncateAll(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  await intruder?.$disconnect();
});

describe('worker dispatch', () => {
  it('routes a task to the handler registered for its type and completes it', async () => {
    const handled: string[] = [];
    const handlers = new WorkTaskHandlerRegistry()
      .register('alpha', async ({ task }) => {
        handled.push(`alpha:${task.id}`);
      })
      .register('beta', async ({ task }) => {
        handled.push(`beta:${task.id}`);
      });

    const a = await repo.enqueue({ type: 'alpha', dedupeKey: 'a' });
    const b = await repo.enqueue({ type: 'beta', dedupeKey: 'b' });

    const worker = buildWorker(handlers);
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false); // nothing left

    expect(handled.sort()).toEqual([`alpha:${a.id}`, `beta:${b.id}`].sort());
    expect((await prisma.workTask.findUniqueOrThrow({ where: { id: a.id } })).status).toBe(
      'SUCCEEDED',
    );
    expect((await prisma.workTask.findUniqueOrThrow({ where: { id: b.id } })).status).toBe(
      'SUCCEEDED',
    );
  });

  it('passes the claimed task (including payload) to the handler', async () => {
    let received: unknown;
    const handledIds: string[] = [];
    const handlers = new WorkTaskHandlerRegistry().register('payload', async ({ task }) => {
      received = task.payload;
      handledIds.push(task.id);
    });
    const task = await repo.enqueue({ type: 'payload', payload: { jobId: '42' }, dedupeKey: 'p' });

    await buildWorker(handlers).runOnce();

    expect(received).toEqual({ jobId: '42' });
    expect(handledIds).toEqual([task.id]);
  });

  it('permanently fails a task whose type has no registered handler', async () => {
    const handlers = new WorkTaskHandlerRegistry();
    const task = await repo.enqueue({ type: 'orphan', dedupeKey: 'orphan' });

    await buildWorker(handlers).runOnce();

    const row = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('FAILED');
    expect(row.lastError).toContain('no handler registered for work task type "orphan"');
  });
});

describe('worker failure classification', () => {
  it('reports a retryable failure and preserves the error message', async () => {
    const handlers = new WorkTaskHandlerRegistry().register('flaky', async () => {
      throw new RetryableWorkTaskError('upstream timed out');
    });
    const task = await repo.enqueue({ type: 'flaky', dedupeKey: 'flaky', maxAttempts: 5 });

    await buildWorker(handlers).runOnce();

    const row = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('PENDING'); // repository scheduled a retry
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('upstream timed out');
  });

  it('reports a permanent failure as FAILED', async () => {
    const handlers = new WorkTaskHandlerRegistry().register('invalid', async () => {
      throw new PermanentWorkTaskError('payload is not a valid job reference');
    });
    const task = await repo.enqueue({ type: 'invalid', dedupeKey: 'invalid', maxAttempts: 5 });

    await buildWorker(handlers).runOnce();

    const row = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(1); // permanent failures do not consume retries
    expect(row.lastError).toContain('payload is not a valid job reference');
  });

  it('treats an unrecognised thrown value as retryable', async () => {
    const handlers = new WorkTaskHandlerRegistry().register('unexpected', async () => {
      throw new Error('socket hang up');
    });
    const task = await repo.enqueue({ type: 'unexpected', dedupeKey: 'unexpected' });

    await buildWorker(handlers).runOnce();

    const row = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('PENDING');
    expect(row.lastError).toContain('socket hang up');
  });

  it('leaves the terminal decision to the repository (retryable failure at maxAttempts dead-letters)', async () => {
    const handlers = new WorkTaskHandlerRegistry().register('always-fails', async () => {
      throw new RetryableWorkTaskError('still failing');
    });
    const task = await repo.enqueue({
      type: 'always-fails',
      dedupeKey: 'always-fails',
      maxAttempts: 1,
    });

    const worker = new WorkTaskWorker(
      immediate,
      handlers,
      {
        workerId: 'test-worker',
        heartbeatIntervalMs: 10_000,
        pollIntervalMs: 5,
        reaperIntervalMs: 5,
      },
      silentWorkerLogger,
    );
    await worker.runOnce();

    const row = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('DEAD_LETTER');
    expect(row.lastError).toContain('still failing');
  });
});

describe('worker leases', () => {
  it('heartbeats while a handler runs so the lease does not lapse', async () => {
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const handlers = new WorkTaskHandlerRegistry().register('slow', async () => {
      markStarted();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const task = await repo.enqueue({ type: 'slow', dedupeKey: 'slow' });

    const worker = buildWorker(handlers, { heartbeatIntervalMs: 10 });
    const run = worker.runOnce();
    await started;

    const before = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
    await new Promise((resolve) => setTimeout(resolve, 80)); // allow several heartbeats
    const during = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });

    expect(during.status).toBe('RUNNING');
    expect(during.leaseToken).toBe(before.leaseToken);
    expect(during.leaseExpiresAt!.getTime()).toBeGreaterThan(before.leaseExpiresAt!.getTime());

    release();
    await run;

    expect((await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      'SUCCEEDED',
    );
  });

  it('never overwrites a newer claim when its lease is stolen mid-execution', async () => {
    let stolenToken: string | null = null;
    const handlers = new WorkTaskHandlerRegistry().register('victim', async ({ task }) => {
      // While we "work", another worker recovers our expired lease and claims it.
      await expireLease(task.id);
      expect(await repo.reapExpiredLeases()).toBe(1);
      const stolenClaim = await intruderRepo.claim('intruder', 60);
      expect(stolenClaim?.id).toBe(task.id);
      stolenToken = stolenClaim?.leaseToken ?? null;
    });
    const task = await repo.enqueue({ type: 'victim', dedupeKey: 'victim' });

    // A long heartbeat interval guarantees our own heartbeat cannot re-extend the
    // lease during the handler, isolating the stale-owner behaviour.
    const worker = buildWorker(handlers, { heartbeatIntervalMs: 30_000 });
    await worker.runOnce();

    const row = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('RUNNING'); // the newer claim still owns it
    expect(row.leaseToken).not.toBeNull();
    expect(row.leaseToken).toBe(stolenToken);
  });
});

describe('worker lifecycle', () => {
  it('recovers an expired lease and then processes the recovered task', async () => {
    const handlers = new WorkTaskHandlerRegistry().register('recoverable', async () => undefined);
    const task = await repo.enqueue({ type: 'recoverable', dedupeKey: 'recoverable' });

    // Simulate a worker that claimed the task and then died.
    const abandoned = await repo.claim('dead-worker', 60);
    expect(abandoned?.id).toBe(task.id);
    await expireLease(task.id);

    const worker = buildWorker(handlers);
    expect(await worker.reapOnce()).toBe(1);
    expect((await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      'PENDING',
    );

    expect(await worker.runOnce()).toBe(true);
    expect((await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      'SUCCEEDED',
    );
  });

  it('processes work through start() and aborts the handler on graceful stop()', async () => {
    let aborted = false;
    const handlers = new WorkTaskHandlerRegistry().register('blocking', async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
    });
    const task = await repo.enqueue({ type: 'blocking', dedupeKey: 'blocking' });

    const worker = buildWorker(handlers, { heartbeatIntervalMs: 10 });
    await worker.start();
    await waitFor(async () => {
      const row = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
      return row.status === 'RUNNING';
    });

    await worker.stop();

    expect(aborted).toBe(true);
    const row = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
    // The interrupted attempt is released for a fresh run, never marked done.
    expect(row.status).toBe('PENDING');
    expect(row.lastError).toContain('aborted');
  });

  it('processes a newly enqueued task through the running loop', async () => {
    const handlers = new WorkTaskHandlerRegistry().register('quick', async () => undefined);
    const worker = buildWorker(handlers);
    await worker.start();
    try {
      const task = await repo.enqueue({ type: 'quick', dedupeKey: 'quick' });
      await waitFor(async () => {
        const row = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
        return row.status === 'SUCCEEDED';
      });
    } finally {
      await worker.stop();
    }
  });
});
