import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DescriptionQuality, LifecycleStatus, SourceRunStatus } from '@domain/enums';
import { LIFECYCLE_POLICY_VERSION } from '@domain/lifecycle/lifecycle-policy';
import { silentWorkerLogger, type WorkerLogger } from '@ports/worker-logger';
import type { JobRepository, LifecycleStatusUpdate, UpsertJobInput } from '@ports/job-repository';
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
/** The collection before RUN_AT: retirement needs two consecutive misses (audit L9). */
const PREV_RUN_AT = new Date('2026-04-30T00:00:00.000Z');
const OBSERVED_BEFORE = new Date('2026-04-29T00:00:00.000Z');
const OBSERVED_AFTER = new Date('2026-05-01T06:00:00.000Z');
/** The oldest publication date a capped run read; published dates are date-only UTC. */
const WINDOW_FLOOR = new Date('2026-04-15T00:00:00.000Z');

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
  publishedAt: Date | null = null,
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
      publishedAt,
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
    /** Defaults true: a healthy run in these tests is a complete catalogue view. */
    catalogueExhausted?: boolean;
    /** The publication-date window a capped run read; null means no window claim. */
    oldestListingPublishedAt?: Date | null;
  } = {},
): Promise<void> {
  await prisma.sourceRun.create({
    data: {
      sourceId,
      status: options.status ?? SourceRunStatus.SUCCEEDED,
      jobsDiscovered: options.jobsDiscovered ?? 5,
      startedAt: options.startedAt ?? RUN_AT,
      catalogueExhausted: options.catalogueExhausted ?? true,
      oldestListingPublishedAt: options.oldestListingPublishedAt ?? null,
    },
  });
}

/**
 * Two consecutive complete reads, both after the Job's last capture: the minimum history that
 * can retire it under `LIFECYCLE_V3` (audit L9).
 */
async function createTwoInformativeRuns(
  sourceId: string,
  options: {
    catalogueExhausted?: boolean;
    oldestListingPublishedAt?: Date | null;
  } = {},
): Promise<void> {
  await createRun(sourceId, { ...options, startedAt: PREV_RUN_AT });
  await createRun(sourceId, { ...options, startedAt: RUN_AT });
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
    await createTwoInformativeRuns(sourceId);

    const result = await sweep.sweep(sourceId);

    expect(result).toEqual({ sourceId, examined: 1, retired: 1, restored: 0 });
    expect(await statusOf(jobId)).toBe(LifecycleStatus.REMOVED);
  });

  it('keeps a job the newest collection still published', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'live', OBSERVED_AFTER);
    await createRun(sourceId);

    const result = await sweep.sweep(sourceId);

    expect(result.retired).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });
});

describe('lifecycle sweep - evidence boundaries', () => {
  it('does not retire from a failed collection', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);
    // One informative collection has missed the job; if the failure counted as a second miss,
    // this would retire it.
    await createRun(sourceId, { startedAt: PREV_RUN_AT });
    await createRun(sourceId, { status: SourceRunStatus.FAILED, startedAt: RUN_AT });

    expect((await sweep.sweep(sourceId)).retired).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not retire from a partial collection', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);
    await createRun(sourceId, { startedAt: PREV_RUN_AT });
    await createRun(sourceId, { status: SourceRunStatus.PARTIAL, startedAt: RUN_AT });

    expect((await sweep.sweep(sourceId)).retired).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not count a capped run that claimed no window as a miss', async () => {
    // A capped or error-cut run discovered records but saw only part of the listing and
    // recorded no date floor: absence from it says nothing about what the unvisited pages
    // held (FR-019), so it is not even a qualifying run and must not count toward retirement.
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);
    await createRun(sourceId, { startedAt: PREV_RUN_AT });
    await createRun(sourceId, {
      startedAt: RUN_AT,
      catalogueExhausted: false,
      oldestListingPublishedAt: null,
    });

    expect((await sweep.sweep(sourceId)).retired).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not retire from a successful zero-result run (AC-018)', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);
    await createRun(sourceId, { startedAt: PREV_RUN_AT });
    await createRun(sourceId, { jobsDiscovered: 0, startedAt: RUN_AT });

    expect((await sweep.sweep(sourceId)).retired).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not retire anything before the source has an informative collection', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);

    expect((await sweep.sweep(sourceId)).retired).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not retire a job whose capture is gone', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);
    // One informative collection has missed the job, so only the missing capture keeps it.
    await createRun(sourceId, { startedAt: PREV_RUN_AT });
    await prisma.job.update({ where: { id: jobId }, data: { rawJobId: null } });

    expect((await sweep.sweep(sourceId)).retired).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  // Audit L9: a single miss is what made retirement flap. A source that intermittently
  // truncates a page retired live jobs and restored them on the next run, and each flap
  // destroyed the job's match and notification history.
  it('retires only after consecutive informative collections miss the job (audit L9)', async () => {
    const sourceId = await createSource('s1');
    // Observed during an older informative run, then the source stopped publishing it.
    const jobId = await createJob(sourceId, 'gone', new Date('2026-04-01T00:00:00.000Z'));
    await createRun(sourceId, { startedAt: PREV_RUN_AT });

    expect((await sweep.sweep(sourceId)).retired).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);

    await createRun(sourceId, { startedAt: RUN_AT });

    expect((await sweep.sweep(sourceId)).retired).toBe(1);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.REMOVED);
  });

  it('counts consecutive misses from the most recent observation', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', new Date('2026-04-01T06:00:00.000Z'));
    await createRun(sourceId, { startedAt: new Date('2026-04-01T00:00:00.000Z') });
    await createRun(sourceId, { startedAt: new Date('2026-04-10T00:00:00.000Z') });
    await createRun(sourceId, { startedAt: new Date('2026-04-20T00:00:00.000Z') });

    // Two consecutive collections after the observation missed it.
    expect((await sweep.sweep(sourceId)).retired).toBe(1);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.REMOVED);

    // The source publishes it again, and one later collection misses it: the count starts over
    // from that observation, so a single miss does not retire the job again.
    const { rawJobId } = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    await prisma.rawJob.update({
      where: { id: rawJobId! },
      data: { lastSeenAt: new Date('2026-04-25T06:00:00.000Z') },
    });
    await createRun(sourceId, { startedAt: new Date('2026-04-25T00:00:00.000Z') });
    await createRun(sourceId, { startedAt: new Date('2026-04-30T00:00:00.000Z') });

    expect((await sweep.sweep(sourceId)).restored).toBe(1);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
    // Two sweeps over real PostgreSQL; the 5 s default is a load-dependent coin flip here.
  }, 30_000);

  it('does not count a failed collection as a consecutive miss', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', new Date('2026-04-02T00:00:00.000Z'));
    await createRun(sourceId, { startedAt: new Date('2026-04-01T00:00:00.000Z') });
    // One qualifying miss, then a failure: if the failure counted, this would be the second.
    await createRun(sourceId, { startedAt: PREV_RUN_AT });
    await createRun(sourceId, { status: SourceRunStatus.FAILED, startedAt: RUN_AT });

    expect((await sweep.sweep(sourceId)).retired).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not retire when only one informative collection exists', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);
    await createRun(sourceId, { startedAt: RUN_AT });

    expect((await sweep.sweep(sourceId)).retired).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });
});

describe('lifecycle sweep - windowed coverage (capped runs)', () => {
  it('retires a job published strictly inside the window the capped runs read', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(
      sourceId,
      'gone',
      OBSERVED_BEFORE,
      LifecycleStatus.ACTIVE,
      new Date('2026-04-20T00:00:00.000Z'),
    );
    await createTwoInformativeRuns(sourceId, {
      catalogueExhausted: false,
      oldestListingPublishedAt: WINDOW_FLOOR,
    });

    expect((await sweep.sweep(sourceId)).retired).toBe(1);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.REMOVED);
  });

  it('does not retire a job published on the window floor', async () => {
    // Published dates are date-only, so the floor date may be split by the page boundary:
    // an equally-dated entry could sit on the unread next page.
    const sourceId = await createSource('s1');
    const jobId = await createJob(
      sourceId,
      'floor',
      OBSERVED_BEFORE,
      LifecycleStatus.ACTIVE,
      WINDOW_FLOOR,
    );
    await createTwoInformativeRuns(sourceId, {
      catalogueExhausted: false,
      oldestListingPublishedAt: WINDOW_FLOOR,
    });

    expect((await sweep.sweep(sourceId)).retired).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not retire a job older than the window', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(
      sourceId,
      'older',
      OBSERVED_BEFORE,
      LifecycleStatus.ACTIVE,
      new Date('2026-04-10T00:00:00.000Z'),
    );
    await createTwoInformativeRuns(sourceId, {
      catalogueExhausted: false,
      oldestListingPublishedAt: WINDOW_FLOOR,
    });

    // It may sit on a page neither run read: no evidence either way (ENG-001).
    expect((await sweep.sweep(sourceId)).retired).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('does not retire an undated job from windowed runs', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'undated', OBSERVED_BEFORE);
    await createTwoInformativeRuns(sourceId, {
      catalogueExhausted: false,
      oldestListingPublishedAt: WINDOW_FLOOR,
    });

    expect((await sweep.sweep(sourceId)).retired).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('retires an undated job when the runs read the whole listing', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'undated', OBSERVED_BEFORE);
    await createTwoInformativeRuns(sourceId, { catalogueExhausted: true });

    expect((await sweep.sweep(sourceId)).retired).toBe(1);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.REMOVED);
  });

  it('restores a retired job observed by a windowed run', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(
      sourceId,
      'back',
      OBSERVED_AFTER,
      LifecycleStatus.REMOVED,
      new Date('2026-03-01T00:00:00.000Z'),
    );
    await createRun(sourceId, {
      catalogueExhausted: false,
      oldestListingPublishedAt: WINDOW_FLOOR,
    });

    // Presence is direct evidence and needs no window: it was observed by this run.
    expect((await sweep.sweep(sourceId)).restored).toBe(1);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('retires from older full reads when newer capped runs cannot reach the job', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(
      sourceId,
      'older',
      new Date('2026-04-01T00:00:00.000Z'),
      LifecycleStatus.ACTIVE,
      new Date('2026-04-10T00:00:00.000Z'),
    );
    // Two complete reads, then the source moved to capped runs above this job's date.
    await createTwoInformativeRuns(sourceId, { catalogueExhausted: true });
    await createRun(sourceId, {
      startedAt: new Date('2026-05-02T00:00:00.000Z'),
      catalogueExhausted: false,
      oldestListingPublishedAt: WINDOW_FLOOR,
    });

    // The newer capped run cannot speak for this Job; the older complete reads still can.
    expect((await sweep.sweep(sourceId)).retired).toBe(1);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.REMOVED);
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

    expect((await sweep.sweep(sourceId)).restored).toBe(1);
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
    await createTwoInformativeRuns(sweptSource);

    const result = await sweep.sweep(sweptSource);

    expect(result.examined).toBe(1);
    expect(await statusOf(sweptJob)).toBe(LifecycleStatus.REMOVED);
    // The other source has no informative run of its own, so its job is untouched.
    expect(await statusOf(otherJob)).toBe(LifecycleStatus.ACTIVE);
  });

  it('is a no-op when re-run', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'gone', OBSERVED_BEFORE);
    await createTwoInformativeRuns(sourceId);

    expect((await sweep.sweep(sourceId)).retired).toBe(1);
    // Still examined (it is a status this policy owns) but no longer a change.
    const second = await sweep.sweep(sourceId);
    expect(second).toEqual({ sourceId, examined: 1, retired: 0, restored: 0 });
    expect(await statusOf(jobId)).toBe(LifecycleStatus.REMOVED);
  });

  // Audit M1, second half: presence restores on its own evidence. A run that read one page and
  // could claim nothing about the rest may not retire, but it *did* see the jobs it captured, and
  // a job it published again is proof the earlier retirement no longer holds. Before this, the
  // handler only looked after a run that stated coverage, so such a job stayed REMOVED until some
  // later run happened to claim a window.
  it('restores a retired job observed by a run that claimed no coverage at all', async () => {
    const sourceId = await createSource('s1');
    // Observed at 06:00, inside the run that started at 00:00 - direct evidence of presence.
    const jobId = await createJob(sourceId, 'back', OBSERVED_AFTER, LifecycleStatus.REMOVED);
    await createRun(sourceId, {
      startedAt: RUN_AT,
      catalogueExhausted: false,
      oldestListingPublishedAt: null,
    });

    const result = await sweep.sweep(sourceId);

    expect(result).toEqual({ sourceId, examined: 1, retired: 0, restored: 1 });
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });
});

describe('lifecycle reconciliation - compare-and-set (audit M1)', () => {
  it('refuses to write over a status another writer moved after this pass read it', async () => {
    const sourceId = await createSource('s1');
    const staleJobId = await createJob(sourceId, 'a', OBSERVED_BEFORE);
    const freshJobId = await createJob(sourceId, 'b', OBSERVED_BEFORE);
    await createTwoInformativeRuns(sourceId);

    const candidates = await jobs.listLifecycleCandidates(sourceId);
    expect(candidates).toHaveLength(2);
    // Both are ACTIVE and both are absent from consecutive listings that were read to the end,
    // so both are decided REMOVED. Then one of them moves underneath the pass, as it would
    // under a second worker or the deadline policy.
    await prisma.job.update({
      where: { id: staleJobId },
      data: { lifecycleStatus: LifecycleStatus.EXPIRED },
    });

    const applied = await jobs.applyLifecycleStatuses(
      candidates.map((candidate) => ({
        jobId: candidate.jobId,
        expectedStatus: candidate.currentStatus,
        status: LifecycleStatus.REMOVED,
      })),
    );

    expect(applied).toBe(1);
    // The deadline policy's determination survives the presence pass that never saw it.
    expect(await statusOf(staleJobId)).toBe(LifecycleStatus.EXPIRED);
    expect(await statusOf(freshJobId)).toBe(LifecycleStatus.REMOVED);
  });

  it('leaves a job another writer expired while this pass was deciding', async () => {
    const sourceId = await createSource('s1');
    const jobId = await createJob(sourceId, 'racy', OBSERVED_AFTER, LifecycleStatus.REMOVED);
    await createRun(sourceId, {
      startedAt: RUN_AT,
      catalogueExhausted: false,
      oldestListingPublishedAt: null,
    });

    const logged: LogEntry[] = [];
    // The pass reads the job as REMOVED and decides to restore it; before its write lands, the
    // deadline policy moves the same row. Without the fence this pass would overwrite a stated
    // deadline with a status it can never re-derive.
    const racing = new RacingJobs(jobs, async () => {
      await prisma.job.update({
        where: { id: jobId },
        data: { lifecycleStatus: LifecycleStatus.EXPIRED },
      });
    });
    const result = await new SweepSourceLifecycle({
      jobs: racing,
      logger: capturingLogger(logged),
    }).sweep(sourceId);

    expect(result.restored).toBe(1);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.EXPIRED);
    expect(
      logged.filter((entry) => entry.message === 'lifecycle sweep left newer state untouched'),
    ).toEqual([
      {
        level: 'info',
        message: 'lifecycle sweep left newer state untouched',
        meta: { sourceId, decided: 1, applied: 0, superseded: 1, policy: LIFECYCLE_POLICY_VERSION },
      },
    ]);
  });
});

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  meta?: unknown;
}

function capturingLogger(sink: LogEntry[]): WorkerLogger {
  return {
    info: (message, meta) => sink.push({ level: 'info', message, meta }),
    warn: (message, meta) => sink.push({ level: 'warn', message, meta }),
    error: (message, meta) => sink.push({ level: 'error', message, meta }),
  };
}

/** Delegates to a real repository, running `before` once just before the lifecycle write. */
class RacingJobs implements JobRepository {
  private raced = false;

  constructor(
    private readonly inner: JobRepository,
    private readonly before: () => Promise<void>,
  ) {}

  async applyLifecycleStatuses(updates: readonly LifecycleStatusUpdate[]) {
    if (!this.raced) {
      this.raced = true;
      await this.before();
    }
    return this.inner.applyLifecycleStatuses(updates);
  }

  findById(id: string) {
    return this.inner.findById(id);
  }

  countForSource(sourceId: string) {
    return this.inner.countForSource(sourceId);
  }

  listLifecycleCandidates(sourceId: string) {
    return this.inner.listLifecycleCandidates(sourceId);
  }

  listDeadlineCandidates() {
    return this.inner.listDeadlineCandidates();
  }

  upsert(input: UpsertJobInput) {
    return this.inner.upsert(input);
  }
}
