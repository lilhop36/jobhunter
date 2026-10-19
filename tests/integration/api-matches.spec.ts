import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import {
  CalendarType,
  DescriptionQuality,
  EmploymentType,
  LifecycleStatus,
  LocationCategory,
  RemoteStatus,
  SalaryPeriod,
  SalaryType,
} from '@domain/enums';
import { MATCHER_VERSION } from '@domain/matching';
import { asPercent, type JobMatch } from '@domain/types';
import { PrismaJobMatchRepository } from '@infrastructure/ingestion/prisma-job-match-repository';
import { applyTestMigrations, createTestPrismaClient, requireTestDatabaseUrl, truncateAll } from '../support/db';
import { parseApiConfig } from '../../apps/api/config';
import { buildApi } from '../../apps/api/main';

/**
 * The match read routes (SRS 3.4; SRS 5.2 `JobMatch`; FR-015).
 *
 * What is pinned: the list is best-score-first and paginates by keyset without skipping or
 * repeating a row (including when two rows share a score); a factor with no evidence is
 * reported as unknown rather than as zero (AC-010); the default revision is the running one; and
 * the detail route carries the evidence the summary does not.
 */

const prisma = createTestPrismaClient();
const matches = new PrismaJobMatchRepository(prisma);
const SCORED_AT = new Date('2026-10-05T00:00:00.000Z');

let app: FastifyInstance;
let appPrisma: PrismaClient;
let counter = 0;
let userId: string;
let sourceId: string;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);

  const user = await prisma.user.create({
    data: { email: `api-matches-${Date.now()}-${counter++}@example.test` },
    select: { id: true },
  });
  userId = user.id;
  sourceId = (
    await prisma.jobSource.create({
      data: { name: `src-${Date.now()}-${counter++}`, adapterType: 'FAKE', adapterVersion: '1.0.0' },
      select: { id: true },
    })
  ).id;

  const api = await buildApi(
    parseApiConfig({
      ...process.env,
      DATABASE_URL: requireTestDatabaseUrl(),
      API_HOST: '127.0.0.1',
    }),
  );
  app = api.app;
  appPrisma = api.prisma;
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await appPrisma.$disconnect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createJob(overrides: { lifecycleStatus?: LifecycleStatus } = {}): Promise<string> {
  const row = await prisma.job.create({
    data: {
      sourceId,
      identityKey: `k-${counter++}`,
      descriptionQuality: DescriptionQuality.SUFFICIENT,
      title: 'Backend Engineer',
      publishedCalendar: CalendarType.GREGORIAN,
      publishedAt: new Date('2026-10-01T00:00:00.000Z'),
      dateConfidence: '0.950',
      locationText: 'Addis Ababa',
      locationCategory: LocationCategory.ADDIS_ABABA,
      remoteStatus: RemoteStatus.ONSITE,
      employmentType: EmploymentType.FULL_TIME,
      salaryType: SalaryType.RANGE,
      salaryMin: '60000.00',
      salaryMax: '90000.00',
      salaryCurrency: 'ETB',
      salaryPeriod: SalaryPeriod.MONTH,
      salaryConfidence: '0.900',
      lifecycleStatus: overrides.lifecycleStatus ?? LifecycleStatus.ACTIVE,
    },
    select: { id: true },
  });
  return row.id;
}

function matchOf(overrides: Partial<JobMatch> = {}): JobMatch {
  return {
    score: asPercent(80),
    confidence: asPercent(50),
    factors: {
      role: asPercent(100),
      skills: null,
      experience: null,
      location: asPercent(70),
      employment: asPercent(100),
      freshness: asPercent(50),
      salary: null,
    },
    matchedSkills: ['TypeScript'],
    missingSkills: [],
    uncertainSkills: ['Docker'],
    matchedEvidence: ['role: Backend Engineer matches your target role'],
    missingEvidence: [],
    uncertainEvidence: ['skills: excluded, no job-side skills were extracted'],
    explanation: 'Role and location match; skills and salary are unknown.',
    matcherVersion: MATCHER_VERSION,
    ...overrides,
  };
}

async function storeMatch(
  options: { score: number; matcherVersion?: string; forUserId?: string; jobId?: string },
): Promise<string> {
  const jobId = options.jobId ?? (await createJob());
  const owner = options.forUserId ?? userId;
  const matcherVersion = options.matcherVersion ?? MATCHER_VERSION;
  await matches.saveIfChanged({
    userId: owner,
    jobId,
    profileVersion: 'p-0001',
    inputHash: `v1:${matcherVersion}:${jobId}`,
    scoredAt: SCORED_AT,
    match: matchOf({ score: asPercent(options.score), matcherVersion }),
  });
  const stored = await matches.findByInput({
    userId: owner,
    jobId,
    matcherVersion,
    inputHash: `v1:${matcherVersion}:${jobId}`,
  });
  if (stored === null) throw new Error('the match under test was not stored');
  return stored.id;
}

describe('GET /api/matches', () => {
  it('lists the current revision best score first, with unknown factors named', async () => {
    await storeMatch({ score: 40 });
    await storeMatch({ score: 90 });
    await storeMatch({ score: 70 });

    const response = await app.inject({ method: 'GET', url: '/api/matches' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      matches: Array<Record<string, unknown>>;
      pagination: { nextCursor: string | null };
    };
    expect(body.matches.map((row) => row.score)).toEqual([90, 70, 40]);
    expect(body.pagination.nextCursor).toBeNull();

    const best = body.matches[0];
    expect(best).toMatchObject({
      userId,
      score: 90,
      confidence: 50,
      matcherVersion: MATCHER_VERSION,
      profileVersion: 'p-0001',
      explanation: 'Role and location match; skills and salary are unknown.',
      scoredAt: SCORED_AT.toISOString(),
    });
    // Excluded factors are named, not left to be read as zero (SRS 4.6, AC-010).
    expect(best.factors).toEqual({
      role: 100,
      skills: null,
      experience: null,
      location: 70,
      employment: 100,
      freshness: 50,
      salary: null,
    });
    expect(best.unknownFactors).toEqual(['skills', 'experience', 'salary']);
  });

  it('paginates by keyset without skipping or repeating a row, ties included', async () => {
    const ids = [
      await storeMatch({ score: 90 }),
      await storeMatch({ score: 70 }),
      await storeMatch({ score: 70 }),
      await storeMatch({ score: 40 }),
    ];

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url: string =
        cursor === null ? '/api/matches?limit=2' : `/api/matches?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        matches: Array<{ id: string }>;
        pagination: { nextCursor: string | null };
      };
      seen.push(...body.matches.map((row) => row.id));
      cursor = body.pagination.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('defaults to the running matcher revision and can be asked for another', async () => {
    await storeMatch({ score: 90 });
    const old = await storeMatch({ score: 95, matcherVersion: '0.9.0' });

    const current = await app.inject({ method: 'GET', url: '/api/matches' });
    const body = current.json() as { matches: Array<{ id: string; matcherVersion: string }> };
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].matcherVersion).toBe(MATCHER_VERSION);

    const explicit = await app.inject({ method: 'GET', url: '/api/matches?matcherVersion=0.9.0' });
    const oldBody = explicit.json() as { matches: Array<{ id: string }> };
    expect(oldBody.matches.map((row) => row.id)).toEqual([old]);
  });

  it('scopes to one candidate when asked', async () => {
    const otherUser = await prisma.user.create({
      data: { email: `other-${Date.now()}-${counter++}@example.test` },
      select: { id: true },
    });
    await storeMatch({ score: 90 });
    const mine = await storeMatch({ score: 60, forUserId: otherUser.id });

    const response = await app.inject({
      method: 'GET',
      url: `/api/matches?userId=${otherUser.id}`,
    });

    const body = response.json() as { matches: Array<{ id: string }> };
    expect(body.matches.map((row) => row.id)).toEqual([mine]);
  });

  it('rejects a cursor it did not issue', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/matches?cursor=${Buffer.from('not json', 'utf8').toString('base64url')}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('GET /api/matches/:id', () => {
  it('returns the evidence behind the summary', async () => {
    const id = await storeMatch({ score: 88 });

    const response = await app.inject({ method: 'GET', url: `/api/matches/${id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id,
      score: 88,
      unknownFactors: ['skills', 'experience', 'salary'],
      skills: { matched: ['TypeScript'], missing: [], uncertain: ['Docker'] },
      evidence: {
        matched: ['role: Backend Engineer matches your target role'],
        missing: [],
        uncertain: ['skills: excluded, no job-side skills were extracted'],
      },
    });
  });

  it('answers 404 for a match that does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/matches/00000000-0000-4000-8000-000000000000',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('answers 400 for an id that is not an id', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/matches/not-a-uuid' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('match read routes and the scoring vocabulary', () => {
  it('publishes a job that later expires, because the row is a recorded decision', async () => {
    // Whatever the lifecycle sweep does to the job, the stored match is the evidence of what was
    // decided at scoring time (SRS 5.2). The list is a record, not a live re-evaluation.
    const jobId = await createJob({ lifecycleStatus: LifecycleStatus.ACTIVE });
    const id = await storeMatch({ score: 75, jobId });

    await prisma.job.update({
      where: { id: jobId },
      data: { lifecycleStatus: LifecycleStatus.EXPIRED },
    });

    const response = await app.inject({ method: 'GET', url: `/api/matches/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id, score: 75 });
  });

  it('never invents evidence for a factor the matcher excluded', async () => {
    const id = await storeMatch({ score: 50 });

    const response = await app.inject({ method: 'GET', url: `/api/matches/${id}` });
    const body = response.json() as { factors: Record<string, number | null>; unknownFactors: string[] };
    expect(body.unknownFactors.length).toBeGreaterThan(0);
    for (const name of body.unknownFactors) {
      expect(body.factors[name]).toBeNull();
    }
  });
});
