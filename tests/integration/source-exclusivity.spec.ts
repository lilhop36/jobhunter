import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * The partial unique index `one_active_run_per_source` is the DB-level
 * guarantee behind FR-003 (source isolation) and the manual-run endpoint's
 * 409 SOURCE_RUN_ACTIVE response. It cannot be expressed in schema.prisma, so
 * this test protects the hand-written migration from being silently dropped.
 */
const prisma = createTestPrismaClient();

async function createSource(name: string): Promise<string> {
  const source = await prisma.jobSource.create({
    data: { name, adapterType: 'test', adapterVersion: '1.0.0' },
  });
  return source.id;
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

describe('source exclusivity (one active run per source)', () => {
  it('rejects a second RUNNING run for the same source', async () => {
    const sourceId = await createSource('exclusive-source');

    await prisma.sourceRun.create({ data: { sourceId, status: 'RUNNING' } });

    await expect(
      prisma.sourceRun.create({ data: { sourceId, status: 'RUNNING' } }),
    ).rejects.toThrow();

    const runningCount = await prisma.sourceRun.count({
      where: { sourceId, status: 'RUNNING' },
    });
    expect(runningCount).toBe(1);
  });

  it('allows a new RUNNING run once the previous run finished', async () => {
    const sourceId = await createSource('sequential-source');

    const first = await prisma.sourceRun.create({ data: { sourceId, status: 'RUNNING' } });
    await prisma.sourceRun.update({
      where: { id: first.id },
      data: { status: 'SUCCEEDED', finishedAt: new Date() },
    });

    const second = await prisma.sourceRun.create({ data: { sourceId, status: 'RUNNING' } });
    expect(second.id).toBeDefined();
    expect(await prisma.sourceRun.count({ where: { sourceId } })).toBe(2);
  });

  it('allows concurrent RUNNING runs for different sources', async () => {
    const a = await createSource('source-a');
    const b = await createSource('source-b');

    await prisma.sourceRun.create({ data: { sourceId: a, status: 'RUNNING' } });
    const runB = await prisma.sourceRun.create({ data: { sourceId: b, status: 'RUNNING' } });

    expect(runB.status).toBe('RUNNING');
  });
});
