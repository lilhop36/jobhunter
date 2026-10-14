import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { DescriptionQuality, EmploymentType, SalaryPeriod, SalaryType } from '@domain/enums';
import { asDecimalAmount, asProbability, type NormalizedJob } from '@domain/types';
import { rawContentHash } from '@domain/normalizers/job-identity';
import { DESCRIPTION_QUALITY_VERSION } from '@domain/normalizers/description-quality';
import { EMPLOYMENT_TYPE_VERSION } from '@domain/normalizers/employment-type';
import { PrismaJobRepository } from '@infrastructure/ingestion/prisma-job-repository';
import { PrismaRawJobRepository } from '@infrastructure/ingestion/prisma-raw-job-repository';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';
import { FakeSourceAdapter, makeRawJob } from '../support/fake-source-adapter';

/**
 * Real-PostgreSQL tests for canonical Job persistence (SRS 5.2, ADR-0001).
 *
 * The identity rule under test: uniqueness is `(sourceId, identityKey)` only, so a
 * content change refreshes the *same* Job and preserves its identity, while content
 * equality stays a separate, non-unique signal. `identityKey` is computed by the
 * domain layer from the raw record and passed in; it is never derived from content.
 */

const prisma = createTestPrismaClient();
const repo = new PrismaJobRepository(prisma);
const adapter = new FakeSourceAdapter();

const DB_NOW_UTC = Prisma.raw("date_trunc('milliseconds', now() AT TIME ZONE 'UTC')");

async function createSource(name: string): Promise<string> {
  const source = await prisma.jobSource.create({
    data: { name, adapterType: 'test', adapterVersion: '1.0.0' },
  });
  return source.id;
}

async function countJobs(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM "jobs"',
  );
  return rows[0].n;
}

async function ageJob(jobId: string, seconds: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "jobs"
    SET "updatedAt" = ${DB_NOW_UTC} - make_interval(secs => ${seconds}::double precision),
        "createdAt" = ${DB_NOW_UTC} - make_interval(secs => ${seconds}::double precision)
    WHERE "id" = ${jobId}::uuid
  `;
}

/** A normalized job produced by real domain code, not a hand-built stub. */
async function normalize(overrides: Parameters<typeof makeRawJob>[0] = {}): Promise<NormalizedJob> {
  return adapter.normalize(
    makeRawJob({
      sourceJobIdentifier: 'job-1',
      sourceUrl: 'https://example.com/jobs/1',
      rawTitle: 'Senior Engineer',
      rawCompany: 'Acme',
      rawLocation: 'Addis Ababa',
      rawDescription: 'Build things.',
      ...overrides,
    }),
  );
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

describe('job upsert', () => {
  it('creates a Job on first upsert and reports it as new', async () => {
    const sourceId = await createSource('job-first');
    const job = await normalize();

    const result = await repo.upsert({ sourceId, identityKey: 'sid:job-1', job });

    expect(result.isNew).toBe(true);
    expect(result.job.identityKey).toBe('sid:job-1');
    expect(result.job.title).toBe('Senior Engineer');
    expect(result.job.canonicalUrl).toBe('https://example.com/jobs/1');
    expect(await countJobs()).toBe(1);
  });

  it('re-upserting the same identity and content refreshes rather than duplicates', async () => {
    const sourceId = await createSource('job-rerun');
    const job = await normalize();

    const first = await repo.upsert({ sourceId, identityKey: 'sid:job-1', job });
    await ageJob(first.job.id, 60);
    const second = await repo.upsert({ sourceId, identityKey: 'sid:job-1', job });

    expect(second.isNew).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(await countJobs()).toBe(1);
    expect(second.job.updatedAt.getTime()).toBeGreaterThan(second.job.createdAt.getTime());
  });

  it('changed content updates the SAME job and preserves the source-scoped identity', async () => {
    const sourceId = await createSource('job-changed');
    const before = await normalize({ rawDescription: 'Build things.' });
    const after = await normalize({ rawDescription: 'Build entirely different things.' });

    // Sanity: the content fingerprint tracks the description; the identity does not.
    expect(after.contentFingerprint).not.toBe(before.contentFingerprint);

    const first = await repo.upsert({ sourceId, identityKey: 'sid:job-1', job: before });
    const second = await repo.upsert({ sourceId, identityKey: 'sid:job-1', job: after });

    expect(second.isNew).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(await countJobs()).toBe(1);
    // Identity stable, content signal changed - they are different concepts.
    expect(second.job.identityKey).toBe('sid:job-1');
    expect(second.job.contentFingerprint).toBe(after.contentFingerprint);
    expect(second.job.description).toBe('Build entirely different things.');
  });

  it('repoints rawJobId at the newest capture while every earlier capture survives', async () => {
    const sourceId = await createSource('job-raw-link');
    const rawRepo = new PrismaRawJobRepository(prisma);

    // Two real captures of the same source record: the source edited the posting.
    const rawBefore = makeRawJob({
      sourceJobIdentifier: 'job-1',
      rawTitle: 'Senior Engineer',
      rawDescription: 'Build things.',
    });
    const rawAfter = makeRawJob({
      sourceJobIdentifier: 'job-1',
      rawTitle: 'Senior Engineer',
      rawDescription: 'Build entirely different things.',
    });
    const captureA = await rawRepo.observe({
      sourceId,
      evidence: rawBefore,
      contentHash: rawContentHash(rawBefore),
    });
    const captureB = await rawRepo.observe({
      sourceId,
      evidence: rawAfter,
      contentHash: rawContentHash(rawAfter),
    });
    expect(captureB.isNewObservation).toBe(true);

    const before = await normalize({ rawDescription: 'Build things.' });
    const after = await normalize({ rawDescription: 'Build entirely different things.' });

    const first = await repo.upsert({
      sourceId,
      identityKey: 'sid:job-1',
      job: before,
      rawJobId: captureA.rawJob.id,
    });
    const second = await repo.upsert({
      sourceId,
      identityKey: 'sid:job-1',
      job: after,
      rawJobId: captureB.rawJob.id,
    });

    // Same Job (identity held), pointing at the newest evidence.
    expect(second.isNew).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.rawJobId).toBe(captureB.rawJob.id);

    // Both captures survive: the earlier one was neither deleted nor rewritten.
    const history = await rawRepo.listForSourceRecord(sourceId, 'job-1');
    expect(history.map((row) => row.id)).toEqual([captureA.rawJob.id, captureB.rawJob.id]);
    const earlier = await rawRepo.findById(captureA.rawJob.id);
    expect(earlier?.rawDescription).toBe('Build things.');
  });

  it('keeps the same identityKey in two sources as two separate Jobs', async () => {
    const sourceA = await createSource('job-source-a');
    const sourceB = await createSource('job-source-b');
    const job = await normalize();

    const a = await repo.upsert({ sourceId: sourceA, identityKey: 'sid:job-1', job });
    const b = await repo.upsert({ sourceId: sourceB, identityKey: 'sid:job-1', job });

    expect(a.job.id).not.toBe(b.job.id);
    expect(await countJobs()).toBe(2);
    expect(await repo.countForSource(sourceA)).toBe(1);
    expect(await repo.countForSource(sourceB)).toBe(1);
  });

  it('keeps two different identities within one source separate', async () => {
    const sourceId = await createSource('job-two-identities');
    const job = await normalize();

    await repo.upsert({ sourceId, identityKey: 'sid:job-1', job });
    await repo.upsert({ sourceId, identityKey: 'sid:job-2', job });

    expect(await countJobs()).toBe(2);
  });

  it('refuses an identity-less Job at the database level', async () => {
    // The ADR rule is structural, not conventional: undeduplicable evidence is never
    // promoted, so a Job without an identity is not representable.
    const sourceId = await createSource('job-identity-required');

    await expect(
      prisma.$executeRawUnsafe(
        'INSERT INTO "jobs" ("id","sourceId","identityKey","descriptionQuality") VALUES (gen_random_uuid(), $1::uuid, NULL, \'UNUSABLE\')',
        sourceId,
      ),
    ).rejects.toThrow(/not-null|null value|23502/i);
  });

  it('stores exact decimal salary amounts without float rounding', async () => {
    const sourceId = await createSource('job-decimals');
    const base = await normalize();
    const job: NormalizedJob = {
      ...base,
      salary: {
        type: SalaryType.RANGE,
        min: asDecimalAmount('1234.56'),
        max: asDecimalAmount('2000.00'),
        currency: 'ETB',
        period: SalaryPeriod.MONTH,
        evidence: 'ETB 1,234.56 - 2,000.00',
        confidence: asProbability(1),
      },
    };

    const { job: stored } = await repo.upsert({ sourceId, identityKey: 'sid:job-1', job });

    const rows = await prisma.$queryRawUnsafe<{ salaryMin: string; salaryMax: string }[]>(
      'SELECT "salaryMin"::text AS "salaryMin", "salaryMax"::text AS "salaryMax" FROM "jobs" WHERE "id" = $1::uuid',
      stored.id,
    );
    expect(rows[0].salaryMin).toBe('1234.56');
    expect(rows[0].salaryMax).toBe('2000.00');
  });

  it('stores the per-field provenance map (ENG-003)', async () => {
    const sourceId = await createSource('job-provenance');
    const job = await normalize();

    const { job: stored } = await repo.upsert({ sourceId, identityKey: 'sid:job-1', job });

    const rows = await prisma.$queryRawUnsafe<{ provenance: Record<string, unknown> }[]>(
      'SELECT "provenance" FROM "jobs" WHERE "id" = $1::uuid',
      stored.id,
    );
    expect(rows[0].provenance).toMatchObject({
      title: { provenance: 'SOURCE' },
      canonicalUrl: { provenance: 'DETERMINISTIC' },
    });
  });

  it('persists description quality rather than inventing it', async () => {
    const sourceId = await createSource('job-description-quality');
    const job = await normalize({ rawDescription: null });
    expect(job.descriptionQuality).toBe(DescriptionQuality.UNUSABLE);

    const { job: stored } = await repo.upsert({ sourceId, identityKey: 'sid:job-1', job });
    expect(stored.descriptionQuality).toBe(DescriptionQuality.UNUSABLE);
  });

  it('persists a sufficient description and its classifier policy version (FR-007)', async () => {
    const sourceId = await createSource('job-description-sufficient');
    const description = Array.from({ length: 30 }, (_, i) => `responsibility${i}`).join(' ');
    const job = await normalize({ rawDescription: description });
    expect(job.descriptionQuality).toBe(DescriptionQuality.SUFFICIENT);
    expect(job.provenance.descriptionQuality?.conversionMethod).toBe(DESCRIPTION_QUALITY_VERSION);

    const { job: stored } = await repo.upsert({ sourceId, identityKey: 'sid:job-1', job });
    expect(stored.descriptionQuality).toBe(DescriptionQuality.SUFFICIENT);

    const rows = await prisma.$queryRawUnsafe<{ provenance: Record<string, unknown> }[]>(
      'SELECT "provenance" FROM "jobs" WHERE "id" = $1::uuid',
      stored.id,
    );
    expect(rows[0].provenance).toMatchObject({
      descriptionQuality: {
        provenance: 'DETERMINISTIC',
        conversionMethod: DESCRIPTION_QUALITY_VERSION,
      },
    });
  });

  it('persists the extracted employment type and its policy version (FR-009)', async () => {
    const sourceId = await createSource('job-employment-type');
    const job = await normalize({ rawTitle: 'Backend Engineer (Contract)' });
    expect(job.employmentType).toBe(EmploymentType.CONTRACT);
    expect(job.provenance.employmentType?.conversionMethod).toBe(EMPLOYMENT_TYPE_VERSION);

    const { job: stored } = await repo.upsert({ sourceId, identityKey: 'sid:job-1', job });

    const rows = await prisma.$queryRawUnsafe<
      { employmentType: string; provenance: Record<string, { conversionMethod?: string }> }[]
    >(
      'SELECT "employmentType"::text AS "employmentType", "provenance" FROM "jobs" WHERE "id" = $1::uuid',
      stored.id,
    );
    expect(rows[0].employmentType).toBe('CONTRACT');
    expect(rows[0].provenance.employmentType?.conversionMethod).toBe(EMPLOYMENT_TYPE_VERSION);
  });
});
