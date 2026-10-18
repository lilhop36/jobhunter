import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SourceRunStatus } from '@domain/enums';
import { SourceRunOutcome } from '@ports/source-run-repository';
import { PrismaSourceRunRepository } from '@infrastructure/ingestion/prisma-source-run-repository';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * The two identity-outcome counters required by ADR-0001 section 4 (the SRS 7.8 funnel).
 *
 * Neither is derivable from the counters that already existed: without `undeduplicable`
 * the funnel arithmetic does not close, and without `fallbackIdentities` the volume
 * resting on the weakest (`fp:`) identity basis is invisible - which is precisely the
 * signal the ADR promised would stay observable. If these are not persisted, the pipeline
 * can compute them but no operator can ever see them again.
 */

const prisma = createTestPrismaClient();
const repo = new PrismaSourceRunRepository(prisma);

const OUTCOME: SourceRunOutcome = {
  status: SourceRunStatus.SUCCEEDED,
  jobsDiscovered: 9,
  jobsAccepted: 4,
  jobsDuplicate: 1,
  jobsRejected: 0,
  parseFailures: 1,
  httpFailures: 0,
  undeduplicable: 3,
  fallbackIdentities: 2,
  unexpectedZeroResults: false,
  enrichmentScheduled: false,
  errorSummary: null,
};

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

describe('source run identity counters', () => {
  it('defaults both counters to zero on a newly started run', async () => {
    const sourceId = await createSource('counters-default');
    const run = await repo.start({ sourceId });
    expect(run.undeduplicable).toBe(0);
    expect(run.fallbackIdentities).toBe(0);
  });

  it('persists both counters on finalize and survives a re-read', async () => {
    const sourceId = await createSource('counters-persist');
    const run = await repo.start({ sourceId });

    const finalized = await repo.finalize(run.id, OUTCOME, null);
    expect(finalized?.undeduplicable).toBe(3);
    expect(finalized?.fallbackIdentities).toBe(2);

    // Re-read through the column list, so a missing column cannot pass by accident.
    const reread = await repo.findById(run.id);
    expect(reread?.undeduplicable).toBe(3);
    expect(reread?.fallbackIdentities).toBe(2);
  });
});
