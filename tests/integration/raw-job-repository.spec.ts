import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { rawContentHash } from '@domain/normalizers/job-identity';
import { PrismaRawJobRepository } from '@infrastructure/ingestion/prisma-raw-job-repository';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';
import { makeRawJob } from '../support/fake-source-adapter';

/**
 * Real-PostgreSQL tests for the append-only raw evidence store (ENG-002, ADR-0001).
 *
 * The identity rule under test is deliberately narrow: identical captured content is
 * one row, changed content is always another row, and nothing is ever overwritten.
 * The fingerprint is computed by the domain layer and passed in - the repository is
 * given it, never asked to derive it.
 */

const prisma = createTestPrismaClient();
const repo = new PrismaRawJobRepository(prisma);

const DB_NOW_UTC = Prisma.raw("date_trunc('milliseconds', now() AT TIME ZONE 'UTC')");

async function createSource(name: string): Promise<string> {
  const source = await prisma.jobSource.create({
    data: { name, adapterType: 'test', adapterVersion: '1.0.0' },
  });
  return source.id;
}

/** Move a capture's timestamps into the past so "advancing" is testable without sleeping. */
async function ageCapture(rawJobId: string, seconds: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "raw_jobs"
    SET "collectedAt" = ${DB_NOW_UTC} - make_interval(secs => ${seconds}::double precision),
        "lastSeenAt"  = ${DB_NOW_UTC} - make_interval(secs => ${seconds}::double precision),
        "createdAt"   = ${DB_NOW_UTC} - make_interval(secs => ${seconds}::double precision)
    WHERE "id" = ${rawJobId}::uuid
  `;
}

async function countRawJobs(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM "raw_jobs"',
  );
  return rows[0].n;
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

describe('raw job capture', () => {
  it('stores a first capture and reports it as new', async () => {
    const sourceId = await createSource('first-capture');
    const evidence = makeRawJob({
      sourceJobIdentifier: 'job-1',
      rawTitle: 'Engineer',
      rawCompany: 'Acme',
    });

    const result = await repo.observe({
      sourceId,
      evidence,
      contentHash: rawContentHash(evidence),
    });

    expect(result.isNewObservation).toBe(true);
    expect(result.rawJob.sourceJobIdentifier).toBe('job-1');
    expect(result.rawJob.rawTitle).toBe('Engineer');
    expect(result.rawJob.contentHash).toBe(rawContentHash(evidence));
    expect(await countRawJobs()).toBe(1);
  });

  it('capturing identical content again adds no row and only advances lastSeenAt', async () => {
    const sourceId = await createSource('identical-rerun');
    const evidence = makeRawJob({
      sourceJobIdentifier: 'job-1',
      rawTitle: 'Engineer',
      rawDescription: 'Build things.',
    });
    const contentHash = rawContentHash(evidence);

    const first = await repo.observe({ sourceId, evidence, contentHash });
    await ageCapture(first.rawJob.id, 60);

    const second = await repo.observe({ sourceId, evidence, contentHash });

    expect(second.isNewObservation).toBe(false);
    expect(second.rawJob.id).toBe(first.rawJob.id);
    expect(await countRawJobs()).toBe(1);
    // lastSeenAt advances; createdAt does not.
    expect(second.rawJob.lastSeenAt.getTime()).toBeGreaterThan(second.rawJob.createdAt.getTime());
  });

  it('does not overwrite captured evidence when the same capture is observed again', async () => {
    const sourceId = await createSource('evidence-immutable');
    const evidence = makeRawJob({ sourceJobIdentifier: 'job-1', rawTitle: 'Engineer' });
    const contentHash = rawContentHash(evidence);

    await repo.observe({ sourceId, evidence, contentHash });
    await repo.observe({ sourceId, evidence, contentHash });

    const history = await repo.listForSourceRecord(sourceId, 'job-1');
    expect(history).toHaveLength(1);
    expect(history[0].rawTitle).toBe('Engineer');
  });

  it('changed content is a new capture and the earlier one is retained', async () => {
    const sourceId = await createSource('changed-content');
    const before = makeRawJob({
      sourceJobIdentifier: 'job-1',
      rawTitle: 'Engineer',
      rawDescription: 'Build things.',
    });
    const after = makeRawJob({
      sourceJobIdentifier: 'job-1',
      rawTitle: 'Engineer',
      rawDescription: 'Build entirely different things.',
    });
    expect(rawContentHash(after)).not.toBe(rawContentHash(before));

    const first = await repo.observe({ sourceId, evidence: before, contentHash: rawContentHash(before) });
    const second = await repo.observe({ sourceId, evidence: after, contentHash: rawContentHash(after) });

    expect(second.isNewObservation).toBe(true);
    expect(second.rawJob.id).not.toBe(first.rawJob.id);
    expect(await countRawJobs()).toBe(2);

    const history = await repo.listForSourceRecord(sourceId, 'job-1');
    expect(history.map((row) => row.rawDescription)).toEqual([
      'Build things.',
      'Build entirely different things.',
    ]);
    // The earlier capture is untouched.
    const original = await repo.findById(first.rawJob.id);
    expect(original?.rawDescription).toBe('Build things.');
    expect(original?.contentHash).toBe(rawContentHash(before));
  });

  it('deduplicates a record with no source identifier on content alone', async () => {
    const sourceId = await createSource('no-identifier');
    const evidence = makeRawJob({ sourceJobIdentifier: null, rawTitle: 'Engineer' });
    const contentHash = rawContentHash(evidence);

    const first = await repo.observe({ sourceId, evidence, contentHash });
    const second = await repo.observe({ sourceId, evidence, contentHash });

    expect(first.isNewObservation).toBe(true);
    expect(second.isNewObservation).toBe(false);
    expect(await countRawJobs()).toBe(1);
    expect(second.rawJob.sourceJobIdentifier).toBeNull();
  });

  it('treats an identifier-bearing and an identifier-less capture as separate observations', async () => {
    // Documented limitation (ADR-0001): the two insert paths use different indexes, so
    // the same content arriving once with and once without an identifier is two rows.
    const sourceId = await createSource('mixed-paths');
    const withId = makeRawJob({ sourceJobIdentifier: 'job-1', rawTitle: 'Engineer' });
    const withoutId = makeRawJob({ sourceJobIdentifier: null, rawTitle: 'Engineer' });

    await repo.observe({ sourceId, evidence: withId, contentHash: rawContentHash(withId) });
    await repo.observe({ sourceId, evidence: withoutId, contentHash: rawContentHash(withoutId) });

    expect(await countRawJobs()).toBe(2);
  });

  it('keeps the same source record from two different sources separate', async () => {
    const sourceA = await createSource('source-a');
    const sourceB = await createSource('source-b');
    const evidence = makeRawJob({ sourceJobIdentifier: 'job-1', rawTitle: 'Engineer' });

    await repo.observe({ sourceId: sourceA, evidence, contentHash: rawContentHash(evidence) });
    await repo.observe({ sourceId: sourceB, evidence, contentHash: rawContentHash(evidence) });

    expect(await countRawJobs()).toBe(2);
  });

  it('preserves the opaque source payload', async () => {
    const sourceId = await createSource('payload');
    const evidence = makeRawJob({
      sourceJobIdentifier: 'job-1',
      rawPayload: { id: 'job-1', nested: { tags: ['a', 'b'] } },
    });

    const { rawJob } = await repo.observe({
      sourceId,
      evidence,
      contentHash: rawContentHash(evidence),
    });

    const rows = await prisma.$queryRawUnsafe<{ rawPayload: unknown }[]>(
      'SELECT "rawPayload" FROM "raw_jobs" WHERE "id" = $1::uuid',
      rawJob.id,
    );
    expect(rows[0].rawPayload).toEqual({ id: 'job-1', nested: { tags: ['a', 'b'] } });
  });

  it('honours a source-reported collection time and stamps observation time otherwise', async () => {
    const sourceId = await createSource('collected-at');
    const reported = new Date('2026-10-01T00:00:00.000Z');
    const withReport = makeRawJob({ sourceJobIdentifier: 'job-1', collectedAt: reported });
    const withoutReport = makeRawJob({ sourceJobIdentifier: 'job-2', collectedAt: null });

    const a = await repo.observe({ sourceId, evidence: withReport, contentHash: rawContentHash(withReport) });
    const b = await repo.observe({ sourceId, evidence: withoutReport, contentHash: rawContentHash(withoutReport) });

    expect(a.rawJob.collectedAt.toISOString()).toBe(reported.toISOString());
    expect(b.rawJob.collectedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('records the run that captured the evidence', async () => {
    const sourceId = await createSource('source-run-link');
    const run = await prisma.sourceRun.create({
      data: { sourceId, status: 'RUNNING', trigger: 'SCHEDULE' },
    });
    const evidence = makeRawJob({ sourceJobIdentifier: 'job-1' });

    const { rawJob } = await repo.observe({
      sourceId,
      sourceRunId: run.id,
      evidence,
      contentHash: rawContentHash(evidence),
    });

    expect(rawJob.sourceRunId).toBe(run.id);
  });
});
