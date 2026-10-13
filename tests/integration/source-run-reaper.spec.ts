import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { SourceRunStatus, SourceRunTrigger } from '@domain/enums';
import { SOURCE_RUN_LEASE_EXPIRED_REASON } from '@domain/types';
import { SourceRunActiveError, SourceRunOutcome } from '@ports/source-run-repository';
import { PrismaSourceRunRepository } from '@infrastructure/ingestion/prisma-source-run-repository';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * Real-PostgreSQL tests for collection-run persistence.
 *
 * Two guarantees matter most here:
 *   - source exclusivity (the `one_active_run_per_source` partial index), and
 *   - stale-run recovery (ENG-025), so a worker that dies mid-run cannot wedge a
 *     source forever, while a still-live "zombie" worker cannot overwrite the
 *     outcome the reaper recorded.
 */

const prisma = createTestPrismaClient();
const repo = new PrismaSourceRunRepository(prisma);

const DB_NOW_UTC = Prisma.raw("date_trunc('milliseconds', now() AT TIME ZONE 'UTC')");

/** A complete, healthy run for a source that returned results. */
const HEALTHY_RUN: SourceRunOutcome = {
  status: SourceRunStatus.SUCCEEDED,
  jobsDiscovered: 12,
  jobsAccepted: 7,
  jobsDuplicate: 3,
  jobsRejected: 2,
  undeduplicable: 0,
  fallbackIdentities: 0,
  parseFailures: 1,
  httpFailures: 0,
  unexpectedZeroResults: false,
  errorSummary: null,
};

async function createSource(name: string): Promise<string> {
  const source = await prisma.jobSource.create({
    data: { name, adapterType: 'test', adapterVersion: '1.0.0' },
  });
  return source.id;
}

/** Move a run's start time into the past so staleness can be tested without waiting. */
async function ageRun(runId: string, seconds: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "source_runs"
    SET "startedAt" = ${DB_NOW_UTC} - make_interval(secs => ${seconds}::double precision)
    WHERE "id" = ${runId}::uuid
  `;
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

describe('source run lifecycle', () => {
  it('opens a RUNNING run with the requested trigger and a zeroed funnel', async () => {
    const sourceId = await createSource('lifecycle');

    const run = await repo.start({ sourceId, trigger: SourceRunTrigger.MANUAL });

    expect(run.status).toBe(SourceRunStatus.RUNNING);
    expect(run.trigger).toBe(SourceRunTrigger.MANUAL);
    expect(run.sourceId).toBe(sourceId);
    expect(run.finishedAt).toBeNull();
    expect(run.durationMs).toBeNull();
    expect(run.errorSummary).toBeNull();
    expect(run.unexpectedZeroResults).toBe(false);
    expect([
      run.jobsDiscovered,
      run.jobsAccepted,
      run.jobsDuplicate,
      run.jobsRejected,
      run.parseFailures,
      run.httpFailures,
    ]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('defaults the trigger to SCHEDULE', async () => {
    const run = await repo.start({ sourceId: await createSource('default-trigger') });
    expect(run.trigger).toBe(SourceRunTrigger.SCHEDULE);
  });

  it('records the funnel and duration on finalize', async () => {
    const run = await repo.start({ sourceId: await createSource('finalize') });

    const finalized = await repo.finalize(run.id, HEALTHY_RUN);

    expect(finalized).not.toBeNull();
    expect(finalized?.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(finalized?.jobsDiscovered).toBe(12);
    expect(finalized?.jobsAccepted).toBe(7);
    expect(finalized?.jobsDuplicate).toBe(3);
    expect(finalized?.jobsRejected).toBe(2);
    expect(finalized?.parseFailures).toBe(1);
    expect(finalized?.finishedAt).toBeInstanceOf(Date);
    expect(finalized?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('flags a completed run that unexpectedly found nothing', async () => {
    const run = await repo.start({ sourceId: await createSource('zero-results') });

    const finalized = await repo.finalize(run.id, {
      ...HEALTHY_RUN,
      status: SourceRunStatus.PARTIAL,
      jobsDiscovered: 0,
      jobsAccepted: 0,
      jobsDuplicate: 0,
      jobsRejected: 0,
      parseFailures: 0,
      unexpectedZeroResults: true,
      errorSummary: 'collector returned zero records',
    });

    expect(finalized?.status).toBe(SourceRunStatus.PARTIAL);
    expect(finalized?.unexpectedZeroResults).toBe(true);
    expect(finalized?.errorSummary).toBe('collector returned zero records');
  });
});

describe('source exclusivity', () => {
  it('refuses a second active run for the same source', async () => {
    const sourceId = await createSource('exclusive');
    await repo.start({ sourceId });

    await expect(repo.start({ sourceId })).rejects.toBeInstanceOf(SourceRunActiveError);
  });

  it('allows an active run per source for different sources', async () => {
    const [a, b] = await Promise.all([createSource('a'), createSource('b')]);

    const [runA, runB] = await Promise.all([repo.start({ sourceId: a }), repo.start({ sourceId: b })]);

    expect(runA.status).toBe(SourceRunStatus.RUNNING);
    expect(runB.status).toBe(SourceRunStatus.RUNNING);
    expect(runA.id).not.toBe(runB.id);
  });

  it('allows a new run once the previous run is finalized', async () => {
    const sourceId = await createSource('sequential');
    const first = await repo.start({ sourceId });
    await repo.finalize(first.id, HEALTHY_RUN);

    const second = await repo.start({ sourceId });

    expect(second.status).toBe(SourceRunStatus.RUNNING);
    expect(second.id).not.toBe(first.id);
  });
});

describe('stale run recovery (ENG-025)', () => {
  it('fails a run that outlives the maximum duration, recording LEASE_EXPIRED', async () => {
    const run = await repo.start({ sourceId: await createSource('stale') });
    await ageRun(run.id, 120);

    const reaped = await repo.reapStaleRuns(60);

    expect(reaped.map((record) => record.id)).toEqual([run.id]);
    expect(reaped[0].status).toBe(SourceRunStatus.FAILED);
    expect(reaped[0].errorSummary).toBe(SOURCE_RUN_LEASE_EXPIRED_REASON);
    expect(reaped[0].finishedAt).toBeInstanceOf(Date);
    // Duration is computed from the database clock, so an abandoned run reports the
    // full time it was held, not the moment recovery happened.
    expect(reaped[0].durationMs).toBeGreaterThanOrEqual(120_000);
  });

  it('leaves a run that is still inside the maximum duration alone', async () => {
    const run = await repo.start({ sourceId: await createSource('in-flight') });
    await ageRun(run.id, 5);

    const reaped = await repo.reapStaleRuns(60);

    expect(reaped).toEqual([]);
    expect((await repo.findById(run.id))?.status).toBe(SourceRunStatus.RUNNING);
  });

  it('never touches a run that already reached a terminal state', async () => {
    const run = await repo.start({ sourceId: await createSource('terminal') });
    await repo.finalize(run.id, HEALTHY_RUN);
    await ageRun(run.id, 600);

    const reaped = await repo.reapStaleRuns(60);

    expect(reaped).toEqual([]);
    const stored = await repo.findById(run.id);
    expect(stored?.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(stored?.errorSummary).toBeNull();
  });

  it('degrades gracefully when it reclaims a run whose worker is still alive', async () => {
    const run = await repo.start({ sourceId: await createSource('zombie') });
    await ageRun(run.id, 120);
    await repo.reapStaleRuns(60);

    // The zombie wakes up and tries to finalize. Zero rows updated: it was reaped,
    // so its outcome must not replace the recorded one.
    const lateFinalize = await repo.finalize(run.id, { ...HEALTHY_RUN, jobsDiscovered: 999 });

    expect(lateFinalize).toBeNull();
    const stored = await repo.findById(run.id);
    expect(stored?.status).toBe(SourceRunStatus.FAILED);
    expect(stored?.errorSummary).toBe(SOURCE_RUN_LEASE_EXPIRED_REASON);
    expect(stored?.jobsDiscovered).toBe(0);
  });

  it('releases the source after a crash so a rerun can start', async () => {
    const sourceId = await createSource('crash-then-rerun');

    // Run 1: the worker dies mid-run, leaving the run RUNNING.
    const abandoned = await repo.start({ sourceId });
    await ageRun(abandoned.id, 120);
    const reaped = await repo.reapStaleRuns(60);
    expect(reaped.map((record) => record.id)).toEqual([abandoned.id]);

    // Run 2: without recovery, the partial index would reject this forever.
    const rerun = await repo.start({ sourceId });
    const finalized = await repo.finalize(rerun.id, HEALTHY_RUN);
    expect(finalized?.status).toBe(SourceRunStatus.SUCCEEDED);

    const runs = await prisma.sourceRun.findMany({
      where: { sourceId },
      orderBy: { startedAt: 'asc' },
    });
    expect(runs).toHaveLength(2);
    expect(runs.map((row) => row.status)).toEqual(['FAILED', 'SUCCEEDED']);
    expect(runs.filter((row) => row.status === 'RUNNING')).toHaveLength(0);
  });
});
