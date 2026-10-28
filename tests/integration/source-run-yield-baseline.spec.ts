import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SourceRunStatus } from '@domain/enums';
import { PrismaSourceRunRepository } from '@infrastructure/ingestion/prisma-source-run-repository';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * Real-PostgreSQL tests for the reduced-yield baseline query (SRS 7.8, FR-020).
 *
 * The rule that reads this data is unit-tested; what matters here is the selection itself:
 * only runs that completed cleanly *and* read their listing to the end may define what a
 * source "normally yields". A capped run, a partial run or another source's run sneaking in
 * would turn the baseline into a number the rule cannot defend.
 */

const prisma = createTestPrismaClient();
const repository = new PrismaSourceRunRepository(prisma);

const BASE_TIME = new Date('2026-05-01T10:00:00.000Z');

async function createSource(name: string): Promise<string> {
  const source = await prisma.jobSource.create({
    data: { name, adapterType: 'FAKE', adapterVersion: '1.0.0' },
  });
  return source.id;
}

interface RunSeed {
  status?: SourceRunStatus;
  discovered: number;
  parseFailures?: number;
  catalogueExhausted?: boolean;
  /** Minutes after BASE_TIME, so ordering is explicit. */
  offsetMinutes: number;
}

async function createRun(sourceId: string, seed: RunSeed): Promise<string> {
  const startedAt = new Date(BASE_TIME.getTime() + seed.offsetMinutes * 60_000);
  const run = await prisma.sourceRun.create({
    data: {
      sourceId,
      status: seed.status ?? SourceRunStatus.SUCCEEDED,
      startedAt,
      finishedAt: startedAt,
      jobsDiscovered: seed.discovered,
      parseFailures: seed.parseFailures ?? 0,
      catalogueExhausted: seed.catalogueExhausted ?? true,
    },
  });
  return run.id;
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

describe('recentCleanYields', () => {
  it('returns only clean full-catalogue runs, newest first, within the limit', async () => {
    const sourceId = await createSource('baseline-mixed');
    await createRun(sourceId, { discovered: 20, offsetMinutes: 1 });
    const second = await createRun(sourceId, { discovered: 18, offsetMinutes: 2 });
    await createRun(sourceId, {
      status: SourceRunStatus.PARTIAL,
      discovered: 2,
      parseFailures: 18,
      offsetMinutes: 3,
    });
    await createRun(sourceId, { discovered: 50, catalogueExhausted: false, offsetMinutes: 4 });
    const newest = await createRun(sourceId, { discovered: 22, offsetMinutes: 5 });

    const samples = await repository.recentCleanYields(sourceId, 2);

    expect(samples.map((sample) => sample.runId)).toEqual([newest, second]);
    expect(samples.map((sample) => sample.parsed)).toEqual([22, 18]);
    expect(samples.map((sample) => sample.jobsDiscovered)).toEqual([22, 18]);
    expect(samples[0].startedAt).toBeInstanceOf(Date);
  });

  it("never mixes in another source's runs", async () => {
    const sourceId = await createSource('baseline-own');
    const otherId = await createSource('baseline-other');
    await createRun(sourceId, { discovered: 9, offsetMinutes: 1 });
    await createRun(otherId, { discovered: 900, offsetMinutes: 2 });

    const samples = await repository.recentCleanYields(sourceId, 3);

    expect(samples).toHaveLength(1);
    expect(samples[0].parsed).toBe(9);
  });

  it('returns an empty list when no clean run exists yet', async () => {
    const sourceId = await createSource('baseline-empty');
    await createRun(sourceId, {
      status: SourceRunStatus.FAILED,
      discovered: 4,
      offsetMinutes: 1,
    });

    await expect(repository.recentCleanYields(sourceId, 3)).resolves.toEqual([]);
  });

  it('rejects a limit that is not a positive integer', async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(repository.recentCleanYields('00000000-0000-0000-0000-000000000001', limit)).rejects.toBeInstanceOf(
        RangeError,
      );
    }
  });
});
