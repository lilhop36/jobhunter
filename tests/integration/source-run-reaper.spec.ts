import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { SourceRunStatus, SourceRunTrigger, HealthStatus } from '@domain/enums';
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
  catalogueExhausted: true,
  oldestListingPublishedAt: null,
  enrichmentScheduled: false,
  errorSummary: null,
};

async function createSource(name: string): Promise<string> {
  const source = await prisma.jobSource.create({
    data: { name, adapterType: 'test', adapterVersion: '1.0.0' },
  });
  return source.id;
}

/**
 * Move a run's liveness evidence into the past so abandonment can be tested without waiting.
 *
 * Both timestamps move together because that is what a dead worker's row actually looks like.
 * Since M2 the sweep judges the heartbeat rather than the age, so aging `startedAt` alone would
 * leave the run looking alive and the reclaim would never happen.
 */
async function ageRun(runId: string, seconds: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "source_runs"
    SET "startedAt" = ${DB_NOW_UTC} - make_interval(secs => ${seconds}::double precision),
        "lastHeartbeatAt" = now() - make_interval(secs => ${seconds}::double precision)
    WHERE "id" = ${runId}::uuid
  `;
}

/**
 * Age only the start time, leaving the heartbeat where the run opened it: a run whose worker is
 * still working, just slowly. This is the state that M2 exists to distinguish from abandonment.
 */
async function ageStartedOnly(runId: string, seconds: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "source_runs"
    SET "startedAt" = ${DB_NOW_UTC} - make_interval(secs => ${seconds}::double precision)
    WHERE "id" = ${runId}::uuid
  `;
}

/** Make a young run stop reporting, as a worker that died after its first batch would. */
async function silenceRun(runId: string, seconds: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "source_runs"
    SET "lastHeartbeatAt" = now() - make_interval(secs => ${seconds}::double precision)
    WHERE "id" = ${runId}::uuid
  `;
}

/** Strip the liveness signal, leaving only a start time: a row written before the column existed. */
async function dropHeartbeat(runId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "source_runs" SET "lastHeartbeatAt" = NULL WHERE "id" = ${runId}::uuid
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

    const finalized = await repo.finalize(run.id, HEALTHY_RUN, null);

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
    }, null);

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
    await repo.finalize(first.id, HEALTHY_RUN, null);

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
    await repo.finalize(run.id, HEALTHY_RUN, null);
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
    const lateFinalize = await repo.finalize(run.id, { ...HEALTHY_RUN, jobsDiscovered: 999 }, null);

    expect(lateFinalize).toBeNull();
    const stored = await repo.findById(run.id);
    expect(stored?.status).toBe(SourceRunStatus.FAILED);
    expect(stored?.errorSummary).toBe(SOURCE_RUN_LEASE_EXPIRED_REASON);
    expect(stored?.jobsDiscovered).toBe(0);
  });

  it('writes no health at all for a run that was already reaped', async () => {
    const sourceId = await createSource('zombie-health');
    const run = await repo.start({ sourceId });
    await ageRun(run.id, 120);
    await repo.reapStaleRuns(60);

    // The zombie now claims the run succeeded. Because the run and its source are written
    // together, the rejected finalize must leave the source's health untouched: a source
    // cannot be stamped healthy by an outcome that was discarded, and there is no second
    // write left behind to do it either.
    const lateFinalize = await repo.finalize(run.id, HEALTHY_RUN, {
      status: HealthStatus.HEALTHY,
      countsAsSuccess: true,
    });

    expect(lateFinalize).toBeNull();
    const source = await prisma.jobSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source.healthStatus).toBe(HealthStatus.UNKNOWN);
    expect(source.lastSuccessfulRunAt).toBeNull();
    expect(source.lastErrorAt).toBeNull();
  });

  it('dates the health it records with the finished run own finish time', async () => {
    const sourceId = await createSource('finalize-health');
    const run = await repo.start({ sourceId });

    const finalized = await repo.finalize(run.id, HEALTHY_RUN, {
      status: HealthStatus.HEALTHY,
      countsAsSuccess: true,
    });

    const source = await prisma.jobSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source.healthStatus).toBe(HealthStatus.HEALTHY);
    // One transaction, one `now()`: the two rows can never disagree about the instant.
    expect(source.lastSuccessfulRunAt).toEqual(finalized?.finishedAt);
  });

  it('leaves the last success in place when a later run fails', async () => {
    const sourceId = await createSource('health-not-cleared');
    const first = await repo.start({ sourceId });
    await repo.finalize(first.id, HEALTHY_RUN, {
      status: HealthStatus.HEALTHY,
      countsAsSuccess: true,
    });
    const success = await prisma.jobSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(success.healthStatus).toBe(HealthStatus.HEALTHY);

    const second = await repo.start({ sourceId });
    await repo.finalize(
      second.id,
      { ...HEALTHY_RUN, status: SourceRunStatus.FAILED },
      { status: HealthStatus.FAILING, countsAsSuccess: false },
    );

    // Both columns survive: "when did it last work" is not aged by a later failure.
    const after = await prisma.jobSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(after.healthStatus).toBe(HealthStatus.FAILING);
    expect(after.lastSuccessfulRunAt).toEqual(success.lastSuccessfulRunAt);
    expect(after.lastErrorAt).not.toBeNull();
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
    const finalized = await repo.finalize(rerun.id, HEALTHY_RUN, null);
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

describe('run liveness (audit M2)', () => {
  // The finding was that age was the only evidence available, so a run that legitimately took
  // longer than the stale window was reclaimed *while it was working*: its source was unlocked,
  // a replacement run started, and the original's outcome was thrown away at finalize. These
  // cases pin the two directions of the fix separately - a slow run survives, a silent one dies.
  it('does not reclaim a run that is old but still reporting', async () => {
    const run = await repo.start({ sourceId: await createSource('slow-but-live') });
    await ageStartedOnly(run.id, 120);

    const reaped = await repo.reapStaleRuns(60);

    expect(reaped).toEqual([]);
    const stored = await repo.findById(run.id);
    expect(stored?.status).toBe(SourceRunStatus.RUNNING);
    expect(stored?.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  it('reclaims a young run that stopped reporting', async () => {
    const run = await repo.start({ sourceId: await createSource('silent-worker') });
    await silenceRun(run.id, 120);

    const reaped = await repo.reapStaleRuns(60);

    expect(reaped.map((record) => record.id)).toEqual([run.id]);
    expect(reaped[0].status).toBe(SourceRunStatus.FAILED);
    expect(reaped[0].errorSummary).toBe(SOURCE_RUN_LEASE_EXPIRED_REASON);
  });

  it('heartbeats a run whose start is older than its own stale window, keeping it alive', async () => {
    const run = await repo.start({ sourceId: await createSource('long-run-with-beats') });
    await ageStartedOnly(run.id, 600);

    // One report per sweep: the run is 10 minutes old against a 60-second window and survives
    // every pass, which is the whole point - the bound is on silence, never on duration.
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await repo.heartbeat(run.id)).toBe(true);
      expect(await repo.reapStaleRuns(60)).toEqual([]);
    }
    expect((await repo.findById(run.id))?.status).toBe(SourceRunStatus.RUNNING);
  });

  it('falls back to the start time for a run that never heartbeated', async () => {
    // A row written before the column exists has no liveness signal of its own, so its start is
    // the only evidence - the fallback must not turn every legacy run into a permanent lock.
    const stale = await repo.start({ sourceId: await createSource('legacy-stale') });
    await dropHeartbeat(stale.id);
    await ageStartedOnly(stale.id, 120);

    // Positive control: an equally legacy run that is *inside* the window must not be reclaimed.
    // Without the explicit UTC conversion, the naive `startedAt` is read in this session's zone
    // and looks hours older than it is, so this row would be reaped too.
    const recent = await repo.start({ sourceId: await createSource('legacy-recent') });
    await dropHeartbeat(recent.id);
    await ageStartedOnly(recent.id, 5);

    const reaped = await repo.reapStaleRuns(60);

    expect(reaped.map((record) => record.id)).toEqual([stale.id]);
    expect((await repo.findById(recent.id))?.status).toBe(SourceRunStatus.RUNNING);
  });

  it('stamps liveness from the database clock and reports the run still active', async () => {
    const run = await repo.start({ sourceId: await createSource('beat') });
    await silenceRun(run.id, 300);

    expect(await repo.heartbeat(run.id)).toBe(true);

    const stored = await repo.findById(run.id);
    expect(stored?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(stored!.lastHeartbeatAt!.getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('refuses to heartbeat a run that is no longer active', async () => {
    const finalizedRun = await repo.start({ sourceId: await createSource('beat-finalized') });
    await repo.finalize(finalizedRun.id, HEALTHY_RUN, null);

    const reapedRun = await repo.start({ sourceId: await createSource('beat-reaped') });
    await ageRun(reapedRun.id, 120);
    await repo.reapStaleRuns(60);

    // A false return is the loop's signal to stop: the run it is writing into is gone, so the
    // only outcome still available to this worker is the one the reaper already recorded.
    expect(await repo.heartbeat(finalizedRun.id)).toBe(false);
    expect(await repo.heartbeat(reapedRun.id)).toBe(false);

    const stored = await repo.findById(reapedRun.id);
    expect(stored?.status).toBe(SourceRunStatus.FAILED);
    expect(stored?.errorSummary).toBe(SOURCE_RUN_LEASE_EXPIRED_REASON);
  });

  it('leaves a different run untouched when one heartbeats', async () => {
    const [sourceA, sourceB] = await Promise.all([createSource('beat-a'), createSource('beat-b')]);
    const runA = await repo.start({ sourceId: sourceA });
    const runB = await repo.start({ sourceId: sourceB });
    await silenceRun(runB.id, 300);
    const beforeB = (await repo.findById(runB.id))?.lastHeartbeatAt;

    expect(await repo.heartbeat(runA.id)).toBe(true);

    // Scoped to its own row: a live run cannot keep a dead one's replacement-looking row alive,
    // and it certainly cannot keep another source's run alive.
    expect((await repo.findById(runB.id))?.lastHeartbeatAt).toEqual(beforeB);
  });
});

describe('stale run recovery input guard (ENG-025)', () => {
  // A non-positive maximum duration is a caller error, not a request to reclaim
  // everything. `reapStaleRuns(0)` would otherwise compute `startedAt < now()` and
  // fail every active run - including one that is perfectly healthy - so the guard
  // must reject the bound *before* the recovery UPDATE executes. These cases seed a
  // genuinely stale run and assert it survives untouched, which proves the throw
  // happens first rather than after a partial reclaim.
  it.each([0, -1])('rejects a max duration of %s before touching any run', async (maxDurationSeconds) => {
    const run = await repo.start({ sourceId: await createSource(`guard-${maxDurationSeconds}`) });
    await ageRun(run.id, 120);

    await expect(repo.reapStaleRuns(maxDurationSeconds)).rejects.toBeInstanceOf(RangeError);

    const stored = await repo.findById(run.id);
    expect(stored?.status).toBe(SourceRunStatus.RUNNING);
    expect(stored?.finishedAt).toBeNull();
    expect(stored?.errorSummary).toBeNull();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a non-finite max duration (%s)',
    async (maxDurationSeconds) => {
      const run = await repo.start({ sourceId: await createSource('guard-nonfinite') });
      await ageRun(run.id, 120);

      await expect(repo.reapStaleRuns(maxDurationSeconds)).rejects.toBeInstanceOf(RangeError);

      expect((await repo.findById(run.id))?.status).toBe(SourceRunStatus.RUNNING);
    },
  );

  it('still reclaims a stale run when the bound is valid', async () => {
    const run = await repo.start({ sourceId: await createSource('guard-valid') });
    await ageRun(run.id, 120);

    const reaped = await repo.reapStaleRuns(60);

    expect(reaped.map((record) => record.id)).toEqual([run.id]);
  });
});
