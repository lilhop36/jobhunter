import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RunSourceCollection,
  type RunSourceCollectionInput,
  type RunSourceCollectionResult,
} from '@application/ingestion';
import { DescriptionQuality, SourceRunStatus } from '@domain/enums';
import {
  SOURCE_RUN_LEASE_EXPIRED_REASON,
  SourceResultExpectation,
  type HealthResult,
  type NormalizedJob,
  type RawJobEvidence,
} from '@domain/types';
import { SourceRunActiveError } from '@ports/source-run-repository';
import type {
  CollectionContext,
  HealthCheckContext,
  JobSourceAdapter,
} from '@ports/source-adapter';
import { silentWorkerLogger, type WorkerLogger } from '@ports/worker-logger';
import { PrismaJobRepository } from '@infrastructure/ingestion/prisma-job-repository';
import { PrismaRawJobRepository } from '@infrastructure/ingestion/prisma-raw-job-repository';
import { PrismaSourceRunRepository } from '@infrastructure/ingestion/prisma-source-run-repository';
import { FakeSourceAdapter, makeFakeConfig, makeRawJob } from '../support/fake-source-adapter';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * Real-PostgreSQL tests for the collection use case (SRS 7.7, SRS 7.8 funnel).
 *
 * The guarantees that matter, all of which are only observable against the real
 * schema (partial indexes, unique indexes, ON CONFLICT routing):
 *
 *   - re-running a collection is idempotent: no duplicate evidence, no duplicate Job,
 *   - raw evidence is written *before* promotion, so an unparseable record is never lost,
 *   - an identity-less record is counted, never promoted,
 *   - the URL identity basis is only used when the adapter declared it trustworthy,
 *   - a run abandoned by a crashed worker is recovered, and the retry is still idempotent.
 */

const prisma = createTestPrismaClient();
const sourceRuns = new PrismaSourceRunRepository(prisma);
const rawJobs = new PrismaRawJobRepository(prisma);
const jobs = new PrismaJobRepository(prisma);
const collection = new RunSourceCollection({
  sourceRuns,
  rawJobs,
  jobs,
  logger: silentWorkerLogger,
});

const NOW = new Date('2026-10-13T12:00:00.000Z');
const STALE_SECONDS = 3600;
/** Generous bound so the pre-existing cases never trip the acquisition timeout. */
const ACQUISITION_TIMEOUT_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  meta?: unknown;
}

function makeCapturingLogger(sink: LogEntry[]): WorkerLogger {
  return {
    info: (message, meta) => sink.push({ level: 'info', message, meta }),
    warn: (message, meta) => sink.push({ level: 'warn', message, meta }),
    error: (message, meta) => sink.push({ level: 'error', message, meta }),
  };
}

let sourceSeq = 0;

async function createSource(): Promise<string> {
  sourceSeq += 1;
  const source = await prisma.jobSource.create({
    data: { name: `collection-${sourceSeq}`, adapterType: 'FAKE', adapterVersion: '1.0.0' },
  });
  return source.id;
}

function makeAdapter(
  sourceId: string,
  rows: RawJobEvidence[],
  canonicalUrlIdentityTrusted = false,
): FakeSourceAdapter {
  return new FakeSourceAdapter(
    makeFakeConfig({ sourceId, canonicalUrlIdentityTrusted }),
    rows,
  );
}

function collectOnce(
  adapter: JobSourceAdapter,
  overrides: Partial<Omit<RunSourceCollectionInput, 'adapter' | 'now' | 'staleRunSeconds'>> = {},
): Promise<RunSourceCollectionResult> {
  return collection.run({
    adapter,
    now: NOW,
    staleRunSeconds: STALE_SECONDS,
    acquisitionTimeoutMs: ACQUISITION_TIMEOUT_MS,
    ...overrides,
  });
}

async function countEvidence(sourceId: string): Promise<number> {
  return prisma.rawJob.count({ where: { sourceId } });
}

/** Delegates to a wrapped adapter, but makes `normalize` throw for selected records. */
class FlakyNormalizeAdapter implements JobSourceAdapter {
  constructor(
    private readonly inner: JobSourceAdapter,
    private readonly shouldFail: (raw: RawJobEvidence) => boolean,
  ) {}

  get config() {
    return this.inner.config;
  }

  collect(context: CollectionContext) {
    return this.inner.collect(context);
  }

  async normalize(raw: RawJobEvidence): Promise<NormalizedJob> {
    if (this.shouldFail(raw)) throw new Error('hostile payload');
    return this.inner.normalize(raw);
  }

  healthCheck(context: HealthCheckContext): Promise<HealthResult> {
    return this.inner.healthCheck(context);
  }
}

/** Aborts the run's signal once acquisition has returned - i.e. shutdown mid-run. */
class AbortAfterCollectAdapter implements JobSourceAdapter {
  constructor(
    private readonly inner: JobSourceAdapter,
    private readonly controller: AbortController,
  ) {}

  get config() {
    return this.inner.config;
  }

  async collect(context: CollectionContext): Promise<RawJobEvidence[]> {
    const rows = await this.inner.collect(context);
    this.controller.abort();
    return rows;
  }

  normalize(raw: RawJobEvidence) {
    return this.inner.normalize(raw);
  }

  healthCheck(context: HealthCheckContext) {
    return this.inner.healthCheck(context);
  }
}

/** Aborts the run's signal and then fails acquisition - i.e. shutdown during acquisition. */
class AbortDuringCollectAdapter implements JobSourceAdapter {
  constructor(
    private readonly inner: JobSourceAdapter,
    private readonly controller: AbortController,
  ) {}

  get config() {
    return this.inner.config;
  }

  async collect(): Promise<RawJobEvidence[]> {
    this.controller.abort();
    throw new Error('socket closed during shutdown');
  }

  normalize(raw: RawJobEvidence) {
    return this.inner.normalize(raw);
  }

  healthCheck(context: HealthCheckContext) {
    return this.inner.healthCheck(context);
  }
}

/** Fails acquisition outright. */
class FailingCollectAdapter implements JobSourceAdapter {
  constructor(
    private readonly inner: JobSourceAdapter,
    private readonly error: Error,
  ) {}

  get config() {
    return this.inner.config;
  }

  async collect(): Promise<RawJobEvidence[]> {
    throw this.error;
  }

  normalize(raw: RawJobEvidence) {
    return this.inner.normalize(raw);
  }

  healthCheck(context: HealthCheckContext) {
    return this.inner.healthCheck(context);
  }
}

/**
 * A source that is slow to answer and does not honour cancellation.
 *
 * `collect` records the signal it was handed and then resolves `delayMs` later
 * regardless, which models the real hazard the acquisition bound exists for: an
 * underlying operation that keeps running after the pipeline has stopped waiting.
 */
class SlowCollectAdapter implements JobSourceAdapter {
  capturedSignal: AbortSignal | undefined;

  constructor(
    private readonly inner: JobSourceAdapter,
    private readonly delayMs: number,
  ) {}

  get config() {
    return this.inner.config;
  }

  async collect(context: CollectionContext): Promise<RawJobEvidence[]> {
    this.capturedSignal = context.signal;
    await delay(this.delayMs);
    return this.inner.collect(context);
  }

  normalize(raw: RawJobEvidence) {
    return this.inner.normalize(raw);
  }

  healthCheck(context: HealthCheckContext) {
    return this.inner.healthCheck(context);
  }
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

describe('RunSourceCollection', () => {
  it('re-collecting identical records adds no evidence or job rows', async () => {
    const sourceId = await createSource();
    const rows = [
      makeRawJob({
        sourceJobIdentifier: 'a-1',
        rawTitle: 'Backend Engineer',
        rawCompany: 'Acme',
        rawDescription: 'Build services.',
      }),
      makeRawJob({ sourceJobIdentifier: 'a-2', rawTitle: 'Data Analyst', rawCompany: 'Acme' }),
    ];

    const first = await collectOnce(makeAdapter(sourceId, rows));
    expect(first.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(first.funnel).toMatchObject({
      collected: 2,
      parsed: 2,
      valid: 2,
      unique: 2,
      duplicates: 0,
      undeduplicable: 0,
      fallbackIdentities: 0,
      parseFailures: 0,
      httpFailures: 0,
    });
    expect(await countEvidence(sourceId)).toBe(2);
    expect(await jobs.countForSource(sourceId)).toBe(2);

    // Every Job traces to a RawJob of the same source (SRS 7.7 traceability).
    for (const jobRow of await prisma.job.findMany({ where: { sourceId } })) {
      const evidence = await rawJobs.findById(jobRow.rawJobId as string);
      expect(evidence?.sourceId).toBe(sourceId);
    }

    const second = await collectOnce(makeAdapter(sourceId, rows));
    expect(second.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(second.funnel).toMatchObject({ collected: 2, unique: 0, duplicates: 2 });
    expect(second.run).toMatchObject({
      status: SourceRunStatus.SUCCEEDED,
      jobsDiscovered: 2,
      jobsAccepted: 0,
      jobsDuplicate: 2,
      jobsRejected: 0,
      undeduplicable: 0,
      fallbackIdentities: 0,
      parseFailures: 0,
      httpFailures: 0,
      unexpectedZeroResults: false,
    });

    expect(await countEvidence(sourceId)).toBe(2);
    expect(await jobs.countForSource(sourceId)).toBe(2);
  });

  it('advances lastSeenAt on re-observation and never rewrites captured fields', async () => {
    const sourceId = await createSource();
    const rows = [makeRawJob({ sourceJobIdentifier: 'b-1', rawTitle: 'Backend Engineer' })];

    await collectOnce(makeAdapter(sourceId, rows));
    const before = await prisma.rawJob.findFirstOrThrow({ where: { sourceId } });

    const second = await collectOnce(makeAdapter(sourceId, rows));
    const after = await prisma.rawJob.findFirstOrThrow({ where: { id: before.id } });

    expect(await countEvidence(sourceId)).toBe(1);
    expect(after.lastSeenAt.getTime()).toBeGreaterThanOrEqual(second.run!.startedAt.getTime());
    // Captured evidence is untouched: the same row, the same captured fields.
    expect(after.collectedAt.getTime()).toBe(before.collectedAt.getTime());
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.rawTitle).toBe(before.rawTitle);
    expect(second.funnel.duplicates).toBe(1);
  });

  it('keeps the earlier capture and repoints the Job when content changes', async () => {
    const sourceId = await createSource();
    const versionOne = makeRawJob({
      sourceJobIdentifier: 'c-1',
      rawTitle: 'Backend Engineer',
      rawDescription: 'Version one.',
    });
    const versionTwo = makeRawJob({
      sourceJobIdentifier: 'c-1',
      rawTitle: 'Backend Engineer',
      rawDescription: 'Version two.',
    });

    await collectOnce(makeAdapter(sourceId, [versionOne]));
    const jobBefore = await prisma.job.findFirstOrThrow({ where: { sourceId } });

    const second = await collectOnce(makeAdapter(sourceId, [versionTwo]));
    expect(second.funnel).toMatchObject({ unique: 0, duplicates: 1 });

    expect(await countEvidence(sourceId)).toBe(2);
    const jobAfter = await prisma.job.findFirstOrThrow({ where: { sourceId } });
    expect(jobAfter.id).toBe(jobBefore.id);
    expect(jobAfter.identityKey).toBe(jobBefore.identityKey);
    expect(jobAfter.rawJobId).not.toBe(jobBefore.rawJobId);
    expect(jobAfter.description).toBe('Version two.');

    // Changed content is a new capture; the earlier one stays reachable as history.
    const history = await rawJobs.listForSourceRecord(sourceId, 'c-1');
    expect(history.map((record) => record.rawDescription)).toEqual([
      'Version one.',
      'Version two.',
    ]);
  });

  it('isolates a record whose normalization throws and keeps its raw evidence', async () => {
    const sourceId = await createSource();
    const good = makeRawJob({ sourceJobIdentifier: 'd-1', rawTitle: 'Backend Engineer' });
    const bad = makeRawJob({ sourceJobIdentifier: 'd-2', rawTitle: 'Hostile' });
    const adapter = new FlakyNormalizeAdapter(
      makeAdapter(sourceId, [good, bad]),
      (raw) => raw.sourceJobIdentifier === 'd-2',
    );

    const result = await collectOnce(adapter);

    expect(result.status).toBe(SourceRunStatus.PARTIAL);
    expect(result.funnel).toMatchObject({
      collected: 2,
      parsed: 1,
      valid: 1,
      unique: 1,
      parseFailures: 1,
    });
    expect(result.run?.errorSummary).toContain('record 1: parse failed');
    // Raw evidence is written before promotion, so the unparsed record is not lost.
    expect(await countEvidence(sourceId)).toBe(2);
    expect(await jobs.countForSource(sourceId)).toBe(1);
  });

  it('counts identity-less records as undeduplicable and never promotes them', async () => {
    const sourceId = await createSource();
    const rows = [
      // A title alone is not a discriminator.
      makeRawJob({ rawTitle: 'Engineer' }),
      // No title names an employer group, not a posting.
      makeRawJob({ rawTitle: null, rawCompany: 'Acme' }),
      makeRawJob({ sourceJobIdentifier: 'e-3', rawTitle: 'Data Analyst' }),
    ];

    const result = await collectOnce(makeAdapter(sourceId, rows));

    expect(result.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(result.funnel).toMatchObject({
      collected: 3,
      valid: 3,
      unique: 1,
      undeduplicable: 2,
    });
    expect(result.run?.undeduplicable).toBe(2);
    // Preserved as evidence, just not promoted.
    expect(await countEvidence(sourceId)).toBe(3);
    expect(await jobs.countForSource(sourceId)).toBe(1);
  });

  it('uses the canonical url as identity only when the adapter declares it trustworthy', async () => {
    const row = makeRawJob({
      sourceUrl: 'https://example.com/jobs/77?utm_source=news#apply',
      rawTitle: 'Backend Engineer',
      rawCompany: 'Acme',
    });

    const untrustedSource = await createSource();
    const untrusted = await collectOnce(makeAdapter(untrustedSource, [row], false));
    const untrustedJob = await prisma.job.findFirstOrThrow({
      where: { sourceId: untrustedSource },
    });
    expect(untrustedJob.identityKey).toMatch(/^fp:/);
    expect(untrusted.funnel.fallbackIdentities).toBe(1);

    const trustedSource = await createSource();
    const trusted = await collectOnce(makeAdapter(trustedSource, [row], true));
    const trustedJob = await prisma.job.findFirstOrThrow({ where: { sourceId: trustedSource } });
    expect(trustedJob.identityKey).toBe('url:https://example.com/jobs/77');
    expect(trusted.funnel.fallbackIdentities).toBe(0);
  });

  it('flags an empty run only when the source is expected to yield results', async () => {
    const sourceId = await createSource();
    const adapter = makeAdapter(sourceId, []);

    const unknown = await collectOnce(adapter, {
      resultExpectation: SourceResultExpectation.UNKNOWN,
    });
    expect(unknown.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(unknown.unexpectedZeroResults).toBe(false);
    expect(unknown.run?.unexpectedZeroResults).toBe(false);

    const expected = await collectOnce(adapter, {
      resultExpectation: SourceResultExpectation.RESULTS_EXPECTED,
    });
    expect(expected.status).toBe(SourceRunStatus.PARTIAL);
    expect(expected.unexpectedZeroResults).toBe(true);
    expect(expected.run?.unexpectedZeroResults).toBe(true);
    expect(expected.run?.errorSummary).toContain('zero results');

    const zeroExpected = await collectOnce(adapter, {
      resultExpectation: SourceResultExpectation.ZERO_EXPECTED,
    });
    expect(zeroExpected.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(zeroExpected.unexpectedZeroResults).toBe(false);
  });

  it('records an acquisition failure as FAILED with the concrete error retained', async () => {
    const sourceId = await createSource();
    const adapter = new FailingCollectAdapter(
      makeAdapter(sourceId, []),
      new Error('connection refused'),
    );

    const result = await collectOnce(adapter);

    expect(result.status).toBe(SourceRunStatus.FAILED);
    expect(result.funnel).toMatchObject({ collected: 0, httpFailures: 1 });
    expect(result.run?.status).toBe(SourceRunStatus.FAILED);
    expect(result.run?.httpFailures).toBe(1);
    expect(result.run?.errorSummary).toContain('connection refused');
    expect(await countEvidence(sourceId)).toBe(0);
  });

  it('stops cleanly on abort without claiming a source failure', async () => {
    const sourceId = await createSource();
    const controller = new AbortController();
    const adapter = new AbortAfterCollectAdapter(
      makeAdapter(sourceId, [
        makeRawJob({ sourceJobIdentifier: 'f-1', rawTitle: 'Backend Engineer' }),
      ]),
      controller,
    );

    const result = await collection.run({
      adapter,
      now: NOW,
      staleRunSeconds: STALE_SECONDS,
      acquisitionTimeoutMs: ACQUISITION_TIMEOUT_MS,
      signal: controller.signal,
    });

    expect(result.status).toBe(SourceRunStatus.PARTIAL);
    expect(result.funnel).toMatchObject({ collected: 1, unique: 0, httpFailures: 0 });
    expect(result.run?.errorSummary).toContain('abort');
    expect(await countEvidence(sourceId)).toBe(0);
  });

  it('treats an acquisition abort as PARTIAL without claiming a source fault', async () => {
    const sourceId = await createSource();
    const controller = new AbortController();
    const adapter = new AbortDuringCollectAdapter(makeAdapter(sourceId, []), controller);

    const result = await collection.run({
      adapter,
      now: NOW,
      staleRunSeconds: STALE_SECONDS,
      acquisitionTimeoutMs: ACQUISITION_TIMEOUT_MS,
      signal: controller.signal,
    });

    // Contrast with the acquisition-failure case above: shutdown is not the source's
    // fault, so no HTTP failure is recorded even though collect threw.
    expect(result.status).toBe(SourceRunStatus.PARTIAL);
    expect(result.funnel.httpFailures).toBe(0);
    expect(result.run?.httpFailures).toBe(0);
    expect(result.run?.status).toBe(SourceRunStatus.PARTIAL);
    expect(result.run?.errorSummary).toContain('aborted during acquisition');
    expect(await countEvidence(sourceId)).toBe(0);
  });

  it('bounds acquisition: a slow source fails the run instead of hanging it', async () => {
    const sourceId = await createSource();
    const adapter = new SlowCollectAdapter(
      makeAdapter(sourceId, [
        makeRawJob({ sourceJobIdentifier: 't-1', rawTitle: 'Backend Engineer' }),
      ]),
      150,
    );

    const result = await collectOnce(adapter, { acquisitionTimeoutMs: 25 });

    expect(result.status).toBe(SourceRunStatus.FAILED);
    expect(result.funnel).toMatchObject({ collected: 0, httpFailures: 1 });
    expect(result.run?.status).toBe(SourceRunStatus.FAILED);
    expect(result.run?.httpFailures).toBe(1);
    expect(result.run?.errorSummary).toContain('timed out after 25ms');
    // The run is finalized, not left RUNNING for the reaper to clean up.
    expect(result.run?.finishedAt).not.toBeNull();
    // The bound is enforced cooperatively: the adapter is asked to stop...
    expect(adapter.capturedSignal?.aborted).toBe(true);
    // ...and an acquisition that never completed cleanly persists nothing.
    expect(await countEvidence(sourceId)).toBe(0);
  });

  it('does not claim a timed-out acquisition was cancelled when it later completes', async () => {
    const sourceId = await createSource();
    const logs: LogEntry[] = [];
    const local = new RunSourceCollection({
      sourceRuns,
      rawJobs,
      jobs,
      logger: makeCapturingLogger(logs),
    });
    const adapter = new SlowCollectAdapter(
      makeAdapter(sourceId, [
        makeRawJob({ sourceJobIdentifier: 'u-1', rawTitle: 'Backend Engineer' }),
      ]),
      150,
    );

    const result = await local.run({
      adapter,
      now: NOW,
      staleRunSeconds: STALE_SECONDS,
      acquisitionTimeoutMs: 25,
    });

    expect(result.status).toBe(SourceRunStatus.FAILED);
    expect(adapter.capturedSignal?.aborted).toBe(true);

    // Let the abandoned operation settle. It must be observed and logged - never
    // silently mistaken for a completed acquisition, and never able to rewrite the run.
    await delay(200);
    expect(logs.some((entry) => /abandoned/i.test(entry.message))).toBe(true);

    const run = await sourceRuns.findById(result.run!.id);
    expect(run?.status).toBe(SourceRunStatus.FAILED);
    expect(run?.jobsDiscovered).toBe(0);
    expect(await countEvidence(sourceId)).toBe(0);
  });

  it('refuses a non-positive acquisition bound before opening a run', async () => {
    const sourceId = await createSource();

    await expect(
      collectOnce(makeAdapter(sourceId, []), { acquisitionTimeoutMs: 0 }),
    ).rejects.toThrow(/acquisitionTimeoutMs/);

    // It failed before doing any work, so no run is left behind.
    expect(await prisma.sourceRun.count({ where: { sourceId } })).toBe(0);
  });

  it('releases the source after a timeout so the next run can recover', async () => {
    const sourceId = await createSource();
    const timedOutAdapter = new SlowCollectAdapter(makeAdapter(sourceId, []), 150);

    const timedOut = await collectOnce(timedOutAdapter, { acquisitionTimeoutMs: 25 });
    expect(timedOut.status).toBe(SourceRunStatus.FAILED);

    // Wait out the abandoned acquisition so it cannot interfere with the retry.
    await delay(200);

    const retry = await collectOnce(
      makeAdapter(sourceId, [
        makeRawJob({ sourceJobIdentifier: 'v-1', rawTitle: 'Backend Engineer' }),
      ]),
    );
    expect(retry.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(retry.funnel.unique).toBe(1);
    expect(await prisma.sourceRun.count({ where: { sourceId } })).toBe(2);
  });

  it('treats a worker shutdown as PARTIAL, never as an acquisition timeout', async () => {
    const sourceId = await createSource();
    const controller = new AbortController();
    const adapter = new SlowCollectAdapter(
      makeAdapter(sourceId, [
        makeRawJob({ sourceJobIdentifier: 'w-1', rawTitle: 'Backend Engineer' }),
      ]),
      150,
    );

    const pending = collection.run({
      adapter,
      now: NOW,
      staleRunSeconds: STALE_SECONDS,
      // Far longer than the shutdown, so only the shutdown can end the run.
      acquisitionTimeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;

    expect(result.status).toBe(SourceRunStatus.PARTIAL);
    expect(result.funnel.httpFailures).toBe(0);
    expect(result.run?.errorSummary).toContain('worker shutdown');
  });

  it('refuses to collect while a live run already holds the source', async () => {
    const sourceId = await createSource();
    await sourceRuns.start({ sourceId });

    await expect(
      collectOnce(makeAdapter(sourceId, [makeRawJob({ sourceJobIdentifier: 'g-1', rawTitle: 'x' })])),
    ).rejects.toBeInstanceOf(SourceRunActiveError);

    expect(await countEvidence(sourceId)).toBe(0);
    expect(await prisma.sourceRun.count({ where: { sourceId } })).toBe(1);
  });

  it('recovers a run abandoned by a crashed worker, and the retry stays idempotent', async () => {
    const sourceId = await createSource();
    const abandoned = await sourceRuns.start({ sourceId });
    // Simulate a worker that died mid-run: still active, but older than the safety bound.
    await prisma.sourceRun.update({
      where: { id: abandoned.id },
      data: { startedAt: new Date(Date.now() - (STALE_SECONDS + 60) * 1000) },
    });

    const rows = [makeRawJob({ sourceJobIdentifier: 'h-1', rawTitle: 'Backend Engineer' })];
    const result = await collectOnce(makeAdapter(sourceId, rows));

    expect(result.status).toBe(SourceRunStatus.SUCCEEDED);
    const reaped = await sourceRuns.findById(abandoned.id);
    expect(reaped?.status).toBe(SourceRunStatus.FAILED);
    expect(reaped?.errorSummary).toBe(SOURCE_RUN_LEASE_EXPIRED_REASON);

    expect(await countEvidence(sourceId)).toBe(1);
    expect(await jobs.countForSource(sourceId)).toBe(1);

    const rerun = await collectOnce(makeAdapter(sourceId, rows));
    expect(rerun.funnel).toMatchObject({ unique: 0, duplicates: 1 });
    expect(await countEvidence(sourceId)).toBe(1);
    expect(await jobs.countForSource(sourceId)).toBe(1);
  });

  it('records a funnel that closes and agrees with the persisted rows', async () => {
    const sourceId = await createSource();
    const rows = [
      makeRawJob({ sourceJobIdentifier: 'i-1', rawTitle: 'Backend Engineer', rawCompany: 'Acme' }),
      makeRawJob({ sourceJobIdentifier: 'i-2', rawTitle: 'Data Analyst' }),
      makeRawJob({ rawTitle: 'Engineer' }),
      makeRawJob({ sourceJobIdentifier: 'i-4', rawTitle: 'Hostile' }),
    ];
    const adapter = new FlakyNormalizeAdapter(
      makeAdapter(sourceId, rows),
      (raw) => raw.sourceJobIdentifier === 'i-4',
    );

    const result = await collectOnce(adapter);
    const { collected, parsed, valid, unique, duplicates, undeduplicable, parseFailures } =
      result.funnel;

    expect(collected).toBe(4);
    // The funnel arithmetic closes, so no record is silently lost between stages.
    expect(collected).toBe(parsed + parseFailures);
    expect(parsed).toBe(valid);
    expect(valid).toBe(unique + duplicates + undeduplicable);
    expect(result.unexpectedZeroResults).toBe(false);

    expect(await countEvidence(sourceId)).toBe(collected);
    expect(await jobs.countForSource(sourceId)).toBe(unique + duplicates);
    expect(result.run).toMatchObject({
      jobsDiscovered: collected,
      jobsAccepted: unique,
      jobsDuplicate: duplicates,
      jobsRejected: 0,
      undeduplicable,
      parseFailures,
    });
  });

  it('retains and promotes an UNUSABLE-description record instead of rejecting it (FR-007)', async () => {
    const sourceId = await createSource();
    const sufficient = Array.from({ length: 30 }, (_, i) => `responsibility${i}`).join(' ');
    const rows = [
      makeRawJob({
        sourceJobIdentifier: 'dq-1',
        rawTitle: 'Backend Engineer',
        rawDescription: '\u200B', // invisible only, not content
      }),
      makeRawJob({
        sourceJobIdentifier: 'dq-2',
        rawTitle: 'Data Analyst',
        rawDescription: 'Apply Submit Cancel', // boilerplate only
      }),
      makeRawJob({
        sourceJobIdentifier: 'dq-3',
        rawTitle: 'Platform Engineer',
        rawDescription: sufficient,
      }),
    ];

    const result = await collectOnce(makeAdapter(sourceId, rows));

    // The SRS excludes UNUSABLE jobs from matching/notification, not from collection:
    // they are persisted for traceability and counted, and nothing is rejected here.
    expect(result.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(result.funnel).toMatchObject({ collected: 3, parsed: 3, valid: 3, unique: 3 });
    expect(result.run).toMatchObject({ jobsRejected: 0 });

    const persisted = await prisma.job.findMany({
      where: { sourceId },
      orderBy: { identityKey: 'asc' },
    });
    expect(persisted.map((job) => job.descriptionQuality)).toEqual([
      DescriptionQuality.UNUSABLE,
      DescriptionQuality.UNUSABLE,
      DescriptionQuality.SUFFICIENT,
    ]);

    // Raw evidence survives classification, so an UNUSABLE record can be reprocessed later.
    expect(await countEvidence(sourceId)).toBe(3);
    const firstEvidence = await rawJobs.findById(persisted[0].rawJobId as string);
    expect(firstEvidence?.rawDescription).toBe('\u200B');
  });

  it('records SRS 7.7 step 10 as deferred, never as performed', async () => {
    const sourceId = await createSource();
    const logs: LogEntry[] = [];
    const local = new RunSourceCollection({
      sourceRuns,
      rawJobs,
      jobs,
      logger: makeCapturingLogger(logs),
    });

    const result = await local.run({
      adapter: makeAdapter(sourceId, [
        makeRawJob({ sourceJobIdentifier: 'x-1', rawTitle: 'Backend Engineer' }),
      ]),
      now: NOW,
      staleRunSeconds: STALE_SECONDS,
      acquisitionTimeoutMs: ACQUISITION_TIMEOUT_MS,
    });

    // Collection genuinely succeeded...
    expect(result.status).toBe(SourceRunStatus.SUCCEEDED);
    // ...but SUCCEEDED must not read as "the whole pipeline ran": the run states that the
    // downstream hand-off was not scheduled, and the remaining dependency is reported.
    expect(result.run?.enrichmentScheduled).toBe(false);
    expect(logs.some((entry) => /step 10.*deferred/i.test(entry.message))).toBe(true);
    // Nothing was enqueued against the (unregistered) enrichment/matching handler.
    expect(await prisma.workTask.count()).toBe(0);
  });
});
