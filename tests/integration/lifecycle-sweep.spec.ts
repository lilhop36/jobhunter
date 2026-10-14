import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DescriptionQuality, LifecycleStatus, SourceRunStatus } from '@domain/enums';
import { silentWorkerLogger } from '@ports/worker-logger';
import { SweepSourceLifecycle } from '@application/lifecycle';
import { PrismaJobRepository } from '@infrastructure/ingestion/prisma-job-repository';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * Real-PostgreSQL tests for the FR-019 lifecycle sweep.
 *
 * The job of this suite is to pin the *evidence boundary*: which collection history may
 * retire a Job, and which must not. A single wrong qualifier here retires a healthy
 * source's whole catalogue, so the failures and the zero-result runs are tested explicitly.
 */

const prisma = createTestPrismaClient();
const jobs = new PrismaJobRepository(prisma);
const sweep = new SweepSourceLifecycle({ jobs, logger: silentWorkerLogger });

const RUN_AT = new Date('2026-05-01T00:00:00.000Z');
const OBSERVED_BEFORE = new Date('2026-04-29T00:00:00.000Z');
const OBSERVED_AFTER = new Date('2026-05-01T06:00:00.000Z');

async function createSource(name: string): Promise<string> {
  const source = await prisma.jobSource.create({
    data: { name, adapterType: 'test', adapterVersion: '1.0.0' },
  });
  return source.id;
}

async function createJob(
  sourceId: string,
  identityKey: string,
  observedAt: Date,
  lifecycleStatus: LifecycleStatus = LifecycleStatus.ACTIVE,
): Promise<string> {
  const raw = await prisma.rawJob.create({
    data: {
      sourceId,
      rawTitle: identityKey,
      // Unique per record so the content dedupe index keeps the fixtures separate.
      contentHash: `hash-${identityKey}`,
      lastSeenAt: observedAt,
    },
  });
  const job = await prisma.job.create({
    data: {
      sourceId,
      rawJobId: raw.id,
      identityKey,
      descriptionQuality: DescriptionQuality.UNUSABLE,
      lifecycleStatus,
    },
  });
  return job.id;
}

async function createRun(
  sourceId: string,
  options: {
    status?: SourceRunStatus;
    jobsDiscovered?: number;
    startedAt?: Date;
  } = {},
): Promise<void> {
  await prisma.sourceRun.create({
    data: {
      sourceId,
      status: options.status ?? SourceRunStatus.SUCCEEDED,
      jobsDiscovered: options.jobsDiscovered ?? 5,
      startedAt: options.startedAt ?? RUN_AT,
    },
  });
}

async function statusOf(jobId: string): Promise<LifecycleStatus | undefined> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  return job?.lifecycleStatus as LifecycleStatus | undefined;
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

describe('lifecycle sweep - retiring jobs', () => {
  it('retires a job the source stopped publishing', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);
    await createRun(sourceId);

    const result = await sweep.sweep(sourceId);

    expect(result).toEqual({ sourceId, examined: 1, changed: 1 });
    expect(await statusOf(jobId)).toBe(LifecycleStatus.REMOVED);
  });

  it('keeps a job the newest collection still published', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'live', OBSERVED_AFTER);
    await createRun(sourceId);

    const result = await sweep.sweep(sourceId);

    expect(result.changed).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });
});

describe('lifecycle sweep - evidence boundaries', () => {
  it('does not retire from a failed collection', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);
    await createRun(sourceId, { status: SourceRunStatus.FAILED });

    expect((await sweep.sweep(sourceId)).changed).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not retire from a partial collection', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);
    await createRun(sourceId, { status: SourceRunStatus.PARTIAL });

    expect((await sweep.sweep(sourceId)).changed).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not retire from a successful zero-result run (AC-018)', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);
    await createRun(sourceId, { jobsDiscovered: 0 });

    expect((await sweep.sweep(sourceId)).changed).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not retire anything before the source has an informative collection', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);

    expect((await sweep.sweep(sourceId)).changed).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not retire a job whose capture is gone', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);
    await createRun(sourceId);
    await prisma.job.update({ where: { id: jobId }, data: { rawJobId: null } });

    expect((await sweep.sweep(sourceId)).changed).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('uses the newest run, not an earlier informative one', async () => {
    const sourceId = await createSource('s1');
    // Observed during an older informative run, then the source published a newer one.
    const jobId = await createJob(sourceId, 'gone', new Date('2026-04-01T00:00:00.000Z'));
    await createRun(sourceId, { startedAt: new Date('2026-04-02T00:00:00.000Z') });
    await createRun(sourceId, { startedAt: RUN_AT });

    expect((await sweep.sweep(sourceId)).changed).toBe(1);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.REMOVED);
  });

  it('ignores a newer run that failed when an older informative run exists', async () => {
    const sourceId = await createSource('s1');
    // Observed by the informative run below, so the failure that follows proves nothing.
    const jobId = await createJob(sourceId, 'gone', new Date('2026-04-03T00:00:00.000Z'));
    await createRun(sourceId, { startedAt: new Date('2026-04-02T00:00:00.000Z') });
    await createRun(sourceId, { status: SourceRunStatus.FAILED, startedAt: RUN_AT });

    expect((await sweep.sweep(sourceId)).changed).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });
});

describe('lifecycle sweep - restoring and isolating', () => {
  it('restores a retired job that is published again', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(
      sourceId,
      'back',
      OBSERVED_AFTER,
      LifecycleStatus.REMOVED,
    );
    await createRun(sourceId);

    expect((await sweep.sweep(sourceId)).changed).toBe(1);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('never touches a status derived from other evidence', async () => {
    const sourceId = await createSource('s1');
    const expired = await createJob(sourceId, 'expired', OBSERVED_BEFORE, LifecycleStatus.EXPIRED);
    const notFound = await createJob(
      sourceId,
      'not-found',
      OBSERVED_BEFORE,
      LifecycleStatus.NOT_FOUND,
    );
    await createRun(sourceId);

    const result = await sweep.sweep(sourceId);

    // Neither is even loaded by the candidate query, so neither is "examined".
    expect(result.examined).toBe(0);
    expect(await statusOf(expired)).toBe(LifecycleStatus.EXPIRED);
    expect(await statusOf(notFound)).toBe(LifecycleStatus.NOT_FOUND);
  });

  it('scopes the sweep to one source', async () => {
    const sweptSource = await createSource('s1');
    const otherSource = await createSource('s2');
    const sweptJob = await createJob(sweptSource, 'a', OBSERVED_BEFORE);
    const otherJob = await createJob(otherSource, 'b', OBSERVED_BEFORE);
    await createRun(sweptSource);

    const result = await sweep.sweep(sweptSource);

    expect(result.examined).toBe(1);
    expect(await statusOf(sweptJob)).toBe(LifecycleStatus.REMOVED);
    // The other source has no informative run of its own, so its job is untouched.
    expect(await statusOf(otherJob)).toBe(LifecycleStatus.ACTIVE);
  });

  it('is a no-op when re-run', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);
    await createRun(sourceId);

    expect((await sweep.sweep(sourceId)).changed).toBe(1);
    // Still examined (it is a status this policy owns) but no longer a change.
    const second = await sweep.sweep(sourceId);
    expect(second).toEqual({ sourceId, examined: 1, changed: 0 });
    expect(await statusOf(jobId)).toBe(LifecycleStatus.REMOVED);
  });
});
