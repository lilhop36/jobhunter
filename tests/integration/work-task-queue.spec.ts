import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PrismaWorkTaskRepository } from '@infrastructure/work-tasks/prisma-work-task-repository';
import { ACTIVE_WORK_TASK_STATUSES } from '@domain/types';
import { WorkTaskStatus } from '@domain/enums';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * Real-PostgreSQL tests for the work queue. These exercise the hand-written SQL
 * that Prisma cannot express (FOR UPDATE SKIP LOCKED, partial unique index,
 * database-time leases), so they must run against PostgreSQL, not a mock.
 */

const prisma = createTestPrismaClient();
// Two extra connections so "concurrent" claims are genuinely concurrent rather
// than serialized by a single connection pool.
let clientA: PrismaClient;
let clientB: PrismaClient;

const repo = new PrismaWorkTaskRepository(prisma);
// Immediate retries so attempt-limit tests do not have to wait out backoff.
const immediate = new PrismaWorkTaskRepository(prisma, {
  backoff: { baseSeconds: 0, factor: 2, maxSeconds: 0 },
});

beforeAll(() => {
  applyTestMigrations();
  clientA = createTestPrismaClient();
  clientB = createTestPrismaClient();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

afterAll(async () => {
  await Promise.all([
    prisma.$disconnect(),
    clientA?.$disconnect(),
    clientB?.$disconnect(),
  ]);
});

async function expireLease(taskId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "work_tasks"
    SET "leaseExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'
    WHERE "id" = ${taskId}::uuid
  `;
}

describe('work queue - claiming', () => {
  it('claims a PENDING task, mints a lease token, and starts the attempt count', async () => {
    await repo.enqueue({ type: 'test.job', payload: { hello: 'world' }, dedupeKey: 'k1' });

    const claimed = await repo.claim('worker-1', 60);

    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('RUNNING');
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimed!.leaseExpiresAt instanceof Date).toBe(true);
    expect(claimed!.payload).toEqual({ hello: 'world' });
  });

  it('returns null when the queue is empty', async () => {
    expect(await repo.claim('w', 60)).toBeNull();
  });

  it('respects runAfter (not yet due)', async () => {
    const task = await repo.enqueue({ type: 't', dedupeKey: 'later' });
    await prisma.$executeRaw`
      UPDATE "work_tasks" SET "runAfter" = (now() AT TIME ZONE 'UTC') + interval '1 hour' WHERE "id" = ${task.id}::uuid
    `;
    expect(await repo.claim('w', 60)).toBeNull();
  });

  it('claims a task exactly once under concurrency', async () => {
    const repoA = new PrismaWorkTaskRepository(clientA, { backoff: { baseSeconds: 0, factor: 2, maxSeconds: 0 } });
    const repoB = new PrismaWorkTaskRepository(clientB, { backoff: { baseSeconds: 0, factor: 2, maxSeconds: 0 } });
    await repoA.enqueue({ type: 't', dedupeKey: 'race' });

    const [a, b] = await Promise.all([repoA.claim('worker-a', 60), repoB.claim('worker-b', 60)]);

    const winners = [a, b].filter((x) => x !== null);
    expect(winners).toHaveLength(1);
    expect([a, b].filter((x) => x === null)).toHaveLength(1);
    expect(await prisma.workTask.count({ where: { status: 'RUNNING' } })).toBe(1);
  });

  it('mints a distinct lease token per claim', async () => {
    const first = await repo.enqueue({ type: 't', dedupeKey: 'tok-1' });
    const second = await repo.enqueue({ type: 't', dedupeKey: 'tok-2' });

    // Claim in priority-independent order: set the second as higher priority.
    await prisma.workTask.update({ where: { id: second.id }, data: { priority: 10 } });
    const c1 = await repo.claim('w', 60);
    const c2 = await repo.claim('w', 60);

    expect(c1).not.toBeNull();
    expect(c2).not.toBeNull();
    expect(c1!.leaseToken).not.toBe(c2!.leaseToken);
    expect([c1!.id, c2!.id].sort()).toEqual([first.id, second.id].sort());
  });
});

describe('active-task deduplication', () => {
  it('returns the existing active task instead of creating a second', async () => {
    const first = await repo.enqueue({ type: 't', dedupeKey: 'dup' });
    const second = await repo.enqueue({ type: 't', dedupeKey: 'dup' });

    expect(second.id).toBe(first.id);
    expect(await prisma.workTask.count()).toBe(1);
  });

  it('still deduplicates while the task is RUNNING', async () => {
    const first = await repo.enqueue({ type: 't', dedupeKey: 'dup-running' });
    const claimed = await repo.claim('w', 60);
    expect(claimed!.id).toBe(first.id);

    const again = await repo.enqueue({ type: 't', dedupeKey: 'dup-running' });
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('RUNNING');
  });

  it('allows a new task once the previous one is terminal', async () => {
    const first = await repo.enqueue({ type: 't', dedupeKey: 'dup-done' });
    const claimed = await repo.claim('w', 60);
    await repo.complete(claimed!.id, claimed!.leaseToken!);

    const second = await repo.enqueue({ type: 't', dedupeKey: 'dup-done' });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('PENDING');
    expect(await prisma.workTask.count({ where: { dedupeKey: 'dup-done' } })).toBe(2);
  });

  it('does not deduplicate rows without a dedupeKey', async () => {
    await repo.enqueue({ type: 't' });
    await repo.enqueue({ type: 't' });
    expect(await prisma.workTask.count()).toBe(2);
  });

  it('keeps the partial index predicate aligned with the active statuses', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'one_active_task_per_dedupe_key'
    `;
    expect(rows).toHaveLength(1);
    const def = rows[0].indexdef;
    expect(def).toContain('UNIQUE');
    expect(def).toContain('dedupeKey');
    expect(def).toContain('PENDING');
    expect(def).toContain('RUNNING');
    expect(def).not.toContain('SUCCEEDED');
    expect(def).not.toContain('DEAD_LETTER');
    expect(def).not.toContain('FAILED');

    const legacy = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE indexname = 'work_tasks_dedupeKey_key'
    `;
    expect(legacy).toHaveLength(0);
  });

  it('mirrors the PostgreSQL WorkTaskStatus enum exactly', async () => {
    const rows = await prisma.$queryRaw<Array<{ label: string }>>`
      SELECT e.enumlabel AS label
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'WorkTaskStatus'
      ORDER BY e.enumsortorder
    `;
    expect(rows.map((r) => r.label)).toEqual(Object.values(WorkTaskStatus));
  });
});

describe('leases, expiry and stale owners', () => {
  it('reaps an expired lease back to PENDING and makes it claimable again', async () => {
    const task = await repo.enqueue({ type: 't', dedupeKey: 'lease' });
    const claimed = await repo.claim('w', 60);
    expect(claimed!.id).toBe(task.id);

    // Lease is still valid.
    expect(await repo.reapExpiredLeases()).toBe(0);

    await expireLease(task.id);
    expect(await repo.reapExpiredLeases()).toBe(1);

    const reread = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(reread.status).toBe('PENDING');
    expect(reread.leaseToken).toBeNull();
    expect(reread.leaseExpiresAt).toBeNull();

    const reclaimed = await repo.claim('w2', 60);
    expect(reclaimed!.id).toBe(task.id);
    expect(reclaimed!.attempts).toBe(2);
  });

  it('heartbeat extends the lease for the current owner', async () => {
    await repo.enqueue({ type: 't', dedupeKey: 'hb' });
    const claimed = (await repo.claim('w', 60))!;
    const before = await prisma.workTask.findUniqueOrThrow({ where: { id: claimed.id } });

    expect(await repo.heartbeat(claimed.id, claimed.leaseToken!, 600)).toBe(true);

    const after = await prisma.workTask.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(after.leaseExpiresAt!.getTime()).toBeGreaterThan(before.leaseExpiresAt!.getTime());
  });

  it('rejects heartbeat/complete/fail from a stale owner after re-claim', async () => {
    const task = await repo.enqueue({ type: 't', dedupeKey: 'stale' });
    const oldClaim = (await repo.claim('old', 60))!;

    await expireLease(task.id);
    await repo.reapExpiredLeases();
    const newClaim = (await repo.claim('new', 60))!;
    expect(newClaim.id).toBe(task.id);
    expect(newClaim.leaseToken).not.toBe(oldClaim.leaseToken);

    expect(await repo.heartbeat(task.id, oldClaim.leaseToken!, 60)).toBe(false);
    expect(await repo.complete(task.id, oldClaim.leaseToken!)).toBeNull();
    expect(
      await repo.fail(task.id, oldClaim.leaseToken!, { message: 'stale', retryable: false }),
    ).toBeNull();

    // The newer attempt still owns the task.
    const current = await prisma.workTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(current.status).toBe('RUNNING');
    expect(current.leaseToken).toBe(newClaim.leaseToken);

    const done = await repo.complete(task.id, newClaim.leaseToken!);
    expect(done?.status).toBe('SUCCEEDED');
  });

  it('does not reap an already-terminal task', async () => {
    const task = await repo.enqueue({ type: 't', dedupeKey: 'terminal' });
    const claimed = (await repo.claim('w', 60))!;
    await repo.complete(claimed.id, claimed.leaseToken!);

    await expireLease(task.id); // no-op: lease already NULLed on completion
    expect(await repo.reapExpiredLeases()).toBe(0);
  });
});

describe('database-time correctness under a non-UTC session timezone', () => {
  it('stores lease and backoff deadlines as UTC regardless of session time zone', async () => {
    // `work_tasks` timestamps are `timestamp(3) without time zone` holding UTC
    // (Prisma's convention). A bare `now()` would be stored in the session zone
    // and shift every deadline by the UTC offset. Force a non-UTC zone and prove
    // the deadlines still round-trip to the expected wall-clock instants.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'America/New_York'`;
      const [{ TimeZone }] = await tx.$queryRaw<Array<{ TimeZone: string }>>`SHOW TIME ZONE`;
      expect(TimeZone).toBe('America/New_York');

      const tzRepo = new PrismaWorkTaskRepository(tx, {
        backoff: { baseSeconds: 30, factor: 2, maxSeconds: 3600 },
      });
      await tzRepo.enqueue({ type: 'tz', dedupeKey: 'non-utc-session' });

      const claimed = (await tzRepo.claim('tz-worker', 60))!;
      expect(claimed.leaseToken).not.toBeNull();
      expect(delaySeconds(claimed.leaseExpiresAt!)).toBeGreaterThan(55);
      expect(delaySeconds(claimed.leaseExpiresAt!)).toBeLessThan(65);

      const failed = await tzRepo.fail(claimed.id, claimed.leaseToken!, {
        message: 'transient',
        retryable: true,
      });
      expect(failed?.status).toBe('PENDING');
      expect(delaySeconds(failed!.runAfter)).toBeGreaterThan(25);
      expect(delaySeconds(failed!.runAfter)).toBeLessThan(35);
    });
  });
});

describe('database-time precision', () => {
  it('makes a task enqueued and claimed within one transaction immediately due', async () => {
    // Inside a transaction `now()` is fixed, so the stored `runAfter` and the
    // claim comparison read the same instant. The value must be rounded to the
    // column's millisecond precision, otherwise `runAfter` could be written up to
    // a millisecond in the future and the task would look not-yet-due.
    await prisma.$transaction(async (tx) => {
      const txRepo = new PrismaWorkTaskRepository(tx);
      const task = await txRepo.enqueue({ type: 'same-tx', dedupeKey: 'same-tx' });

      const claimed = await txRepo.claim('same-tx-worker', 60);

      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(task.id);
      expect(claimed!.status).toBe('RUNNING');
    });
  });
});

describe('failure handling and retries', () => {
  it('permanently fails a non-retryable failure', async () => {
    await repo.enqueue({ type: 't', dedupeKey: 'perm' });
    const claimed = (await repo.claim('w', 60))!;

    const failed = await repo.fail(claimed.id, claimed.leaseToken!, {
      message: 'invalid payload',
      retryable: false,
    });

    expect(failed?.status).toBe('FAILED');
    expect(failed?.lastError).toBe('invalid payload');
    expect(failed?.finishedAt).not.toBeNull();
    expect(await repo.claim('w', 60)).toBeNull();
  });

  it('retries a retryable failure, then dead-letters at maxAttempts', async () => {
    await immediate.enqueue({ type: 't', dedupeKey: 'max', maxAttempts: 2 });

    const c1 = (await immediate.claim('w', 60))!;
    expect(c1.attempts).toBe(1);
    const r1 = await immediate.fail(c1.id, c1.leaseToken!, { message: 'transient', retryable: true });
    expect(r1?.status).toBe('PENDING');
    expect(r1?.lastError).toBe('transient');

    const c2 = (await immediate.claim('w', 60))!;
    expect(c2.attempts).toBe(2);
    const r2 = await immediate.fail(c2.id, c2.leaseToken!, { message: 'transient', retryable: true });
    expect(r2?.status).toBe('DEAD_LETTER');
    expect(r2?.finishedAt).not.toBeNull();

    expect(await immediate.claim('w', 60)).toBeNull();
  });

  it('applies bounded exponential backoff between retries', async () => {
    const backoffRepo = new PrismaWorkTaskRepository(prisma, {
      backoff: { baseSeconds: 30, factor: 2, maxSeconds: 3600 },
    });
    await backoffRepo.enqueue({ type: 't', dedupeKey: 'backoff' });

    const c1 = (await backoffRepo.claim('w', 60))!;
    const r1 = await backoffRepo.fail(c1.id, c1.leaseToken!, {
      message: 'transient',
      retryable: true,
    });
    expect(delaySeconds(r1!.runAfter)).toBeGreaterThan(25);
    expect(delaySeconds(r1!.runAfter)).toBeLessThan(35);

    // Wait out the first delay, then retry; the second delay must be ~2x.
    await prisma.$executeRaw`
      UPDATE "work_tasks" SET "runAfter" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE "id" = ${c1.id}::uuid
    `;
    const c2 = (await backoffRepo.claim('w', 60))!;
    expect(c2.attempts).toBe(2);
    const r2 = await backoffRepo.fail(c2.id, c2.leaseToken!, {
      message: 'transient',
      retryable: true,
    });
    expect(delaySeconds(r2!.runAfter)).toBeGreaterThan(55);
    expect(delaySeconds(r2!.runAfter)).toBeLessThan(65);
  });

  it('rejects a non-positive lease duration', async () => {
    await expect(repo.claim('w', 0)).rejects.toThrow(RangeError);
    await expect(repo.claim('w', -5)).rejects.toThrow(RangeError);
  });
});

/** Seconds between now and a future timestamp, using wall-clock as a sanity check. */
function delaySeconds(runAfter: Date): number {
  return (runAfter.getTime() - Date.now()) / 1000;
}
