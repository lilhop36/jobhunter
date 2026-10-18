import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DescriptionQuality } from '@domain/enums';
import { asPercent, type JobMatch } from '@domain/types';
import { PrismaJobMatchRepository } from '@infrastructure/ingestion/prisma-job-match-repository';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * Real-PostgreSQL tests for match persistence (SRS 5.2 JobMatch, 5.6; ADR-0005).
 *
 * The interesting properties are not "does a row exist" but the write contract:
 *   - one row per canonical input set, however many times it is re-scored (idempotent
 *     across a crash + rerun);
 *   - a changed profile/job writes a *new* row rather than mutating history;
 *   - a clock-only change (freshness) rewrites the same row in place;
 *   - the evidence document round-trips structurally, and an unknown version fails loudly.
 */

const prisma = createTestPrismaClient();
const matches = new PrismaJobMatchRepository(prisma);

let userId: string;
let jobId: string;

const MATCHER_VERSION = '1.0.0';

beforeAll(() => {
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);
  const user = await prisma.user.create({ data: { email: `matcher-${Date.now()}@example.test` } });
  userId = user.id;
  const source = await prisma.jobSource.create({
    data: { name: `src-${Date.now()}`, adapterType: 'FAKE', adapterVersion: '1.0.0' },
  });
  const job = await prisma.job.create({
    data: {
      sourceId: source.id,
      identityKey: 'k1',
      descriptionQuality: DescriptionQuality.SUFFICIENT,
    },
    select: { id: true },
  });
  jobId = job.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A scored match with a skills-less breakdown (the interim state of D3/ADR-0005 §2). */
function scored(overrides: Partial<JobMatch> = {}): JobMatch {
  return {
    score: asPercent(90),
    confidence: asPercent(56),
    factors: {
      role: asPercent(100),
      skills: null,
      experience: null,
      location: asPercent(100),
      employment: asPercent(100),
      freshness: asPercent(100),
      salary: null,
    },
    matchedSkills: [],
    missingSkills: [],
    uncertainSkills: [],
    matchedEvidence: ['role: exact target-role match'],
    missingEvidence: [],
    uncertainEvidence: ['skills: no job-side skill extraction'],
    explanation: '90/100 relevance, 56% confidence (matcher 1.0.0).',
    matcherVersion: MATCHER_VERSION,
    ...overrides,
  };
}

function save(
  match: JobMatch,
  overrides: Partial<{ profileVersion: string; inputHash: string; scoredAt: Date }> = {},
) {
  return matches.saveIfChanged({
    userId,
    jobId,
    profileVersion: overrides.profileVersion ?? 'v1:profile-a',
    inputHash: overrides.inputHash ?? 'hash-a',
    scoredAt: overrides.scoredAt ?? new Date('2026-10-19T00:00:00.000Z'),
    match,
  });
}

describe('PrismaJobMatchRepository.saveIfChanged', () => {
  it('inserts a match and reads the evidence document back structurally', async () => {
    expect(await save(scored({ matchedSkills: ['TypeScript'], missingSkills: ['PostgreSQL'] }))).toBe(
      'inserted',
    );

    const row = await matches.findByInput({
      userId,
      jobId,
      matcherVersion: MATCHER_VERSION,
      inputHash: 'hash-a',
    });

    expect(row).not.toBeNull();
    expect(row?.score).toBe(90);
    expect(row?.confidence).toBe(56);
    // A factor with no evidence is NULL, not 0 (AC-010).
    expect(row?.factors.skills).toBeNull();
    expect(row?.factors.role).toBe(100);
    // Skill names survive as structure, not re-parsed from the statement lines.
    expect(row?.matchedSkills).toEqual(['TypeScript']);
    expect(row?.missingSkills).toEqual(['PostgreSQL']);
    expect(row?.uncertainEvidence).toEqual(['skills: no job-side skill extraction']);
    expect(row?.profileVersion).toBe('v1:profile-a');
  });

  it('is idempotent: a rerun with identical inputs writes nothing', async () => {
    expect(await save(scored())).toBe('inserted');
    const first = await prisma.jobMatch.findFirstOrThrow({ where: { userId, jobId } });

    expect(await save(scored())).toBe('unchanged');

    const rows = await prisma.jobMatch.findMany({ where: { userId, jobId } });
    expect(rows).toHaveLength(1);
    // `scoredAt` is untouched too: an unchanged result is not rewritten.
    expect(rows[0].scoredAt.getTime()).toBe(first.scoredAt.getTime());
    expect(rows[0].createdAt.getTime()).toBe(first.createdAt.getTime());
  });

  it('keeps exactly one row per input set across a crash and rerun', async () => {
    // A handler that crashes after writing and is re-run must not duplicate the match.
    await save(scored());
    await save(scored());
    await save(scored());

    expect(await prisma.jobMatch.count({ where: { userId, jobId } })).toBe(1);
  });

  it('writes a new row when the canonical inputs change, preserving history', async () => {
    await save(scored({ score: asPercent(90) }), { inputHash: 'hash-a' });
    // A profile edit changes the input hash: a *new* score, not an overwrite.
    await save(scored({ score: asPercent(70) }), { inputHash: 'hash-b', profileVersion: 'v1:profile-b' });

    const rows = await prisma.jobMatch.findMany({ where: { userId, jobId }, orderBy: { score: 'desc' } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.score)).toEqual([90, 70]);
    expect(rows.map((r) => r.inputHash).sort()).toEqual(['hash-a', 'hash-b']);
  });

  it('rewrites the same row in place when only the output changes (freshness moved)', async () => {
    await save(scored({ score: asPercent(90) }), { inputHash: 'hash-a' });
    // Same inputs, older posting → lower freshness → different output, same row.
    const updated = await save(scored({ score: asPercent(88), confidence: asPercent(55) }), {
      inputHash: 'hash-a',
      scoredAt: new Date('2026-11-19T00:00:00.000Z'),
    });

    expect(updated).toBe('updated');
    const rows = await prisma.jobMatch.findMany({ where: { userId, jobId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(88);
    expect(rows[0].scoredAt.toISOString()).toBe('2026-11-19T00:00:00.000Z');
  });

  it('scopes matches per user and per job', async () => {
    const other = await prisma.user.create({ data: { email: `other-${Date.now()}@example.test` } });
    await save(scored());
    await matches.saveIfChanged({
      userId: other.id,
      jobId,
      profileVersion: 'v1:profile-a',
      inputHash: 'hash-a',
      scoredAt: new Date('2026-10-19T00:00:00.000Z'),
      match: scored(),
    });

    expect(await prisma.jobMatch.count({ where: { jobId } })).toBe(2);
  });

  it('rejects a stored evidence document it does not recognise', async () => {
    await prisma.$executeRaw`
      INSERT INTO "job_matches" (
        "id", "userId", "jobId", "score", "confidence", "evidence", "explanation",
        "matcherVersion", "profileVersion", "inputHash", "scoredAt"
      ) VALUES (
        gen_random_uuid(), ${userId}::uuid, ${jobId}::uuid, 10, 10,
        ${'{"version":99}'}::jsonb, 'x', ${MATCHER_VERSION}, 'v1:x', 'hash-x', now()
      )
    `;
    const row = await prisma.jobMatch.findFirstOrThrow({ where: { userId, inputHash: 'hash-x' } });

    await expect(matches.findById(row.id)).rejects.toThrow(/unrecognised evidence document/);
  });
});
