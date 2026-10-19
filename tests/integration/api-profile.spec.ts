import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { profileVersionOf, type UnversionedCandidateProfile } from '@domain/matching';
import { applyTestMigrations, createTestPrismaClient, requireTestDatabaseUrl, truncateAll } from '../support/db';
import { parseApiConfig } from '../../apps/api/config';
import { buildApi } from '../../apps/api/main';

/**
 * The profile routes (SRS 3.4; SRS 5.2 CandidateProfile; FR-012, SRS 11.2 backfill).
 *
 * What is pinned: a profile is read and replaced whole; the published `profileVersion` labels
 * exactly the published facts, which is what makes a stored `JobMatch` reproducible (ENG-012);
 * a save that changes the revision asks for a `PROFILE_CHANGED` re-score, and a save that does
 * not change it asks for nothing; and an invalid body changes nothing.
 */

const prisma = createTestPrismaClient();

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

  userId = (
    await prisma.user.create({
      data: { email: `api-profile-${Date.now()}-${counter++}@example.test` },
      select: { id: true },
    })
  ).id;

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

interface ProfileBody {
  experienceYears: number | null;
  remotePreference: string;
  relocationPreference: string;
  salaryPreference: {
    min: string | null;
    currency: string | null;
    period: string | null;
    requireDisclosed: boolean;
  } | null;
  employmentPreferences: string[];
  skills: Array<{ canonicalSkill: string; skillType: string; confidence: number }>;
  targetRoles: Array<{ title: string; aliases: string[] }>;
  locationPreferences: Array<{ category: string; text: string | null }>;
}

function profileBody(overrides: Partial<ProfileBody> = {}): ProfileBody {
  return {
    experienceYears: 5,
    remotePreference: 'NO_PREFERENCE',
    relocationPreference: 'UNDECIDED',
    salaryPreference: {
      min: '50000.00',
      currency: 'ETB',
      period: 'MONTH',
      requireDisclosed: false,
    },
    employmentPreferences: ['FULL_TIME'],
    skills: [{ canonicalSkill: 'TypeScript', skillType: 'EXACT_MATCH', confidence: 0.9 }],
    targetRoles: [{ title: 'Backend Engineer', aliases: ['Server Developer'] }],
    locationPreferences: [{ category: 'ADDIS_ABABA', text: null }],
    ...overrides,
  };
}

const put = (body: unknown) =>
  app.inject({ method: 'PUT', url: `/api/profile?userId=${userId}`, payload: body as object });

const get = () => app.inject({ method: 'GET', url: `/api/profile?userId=${userId}` });

async function backfillTasks() {
  return prisma.workTask.findMany({
    where: { type: 'match.score' },
    orderBy: { createdAt: 'asc' },
  });
}

describe('GET /api/profile', () => {
  it('answers 404 for a candidate who has never saved a profile', async () => {
    const response = await get();

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('requires the candidate to be named', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/profile' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns the stored profile after a save', async () => {
    const body = profileBody();
    await put(body);

    const response = await get();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      userId,
      experienceYears: 5,
      remotePreference: 'NO_PREFERENCE',
      relocationPreference: 'UNDECIDED',
      salaryPreference: { min: '50000.00', currency: 'ETB', period: 'MONTH', requireDisclosed: false },
      employmentPreferences: ['FULL_TIME'],
      skills: [{ canonicalSkill: 'TypeScript', skillType: 'EXACT_MATCH', confidence: 0.9 }],
      targetRoles: [{ title: 'Backend Engineer', aliases: ['Server Developer'] }],
      locationPreferences: [{ category: 'ADDIS_ABABA', text: null }],
    });
  });
});

describe('PUT /api/profile', () => {
  it('creates the profile and returns the revision it stored', async () => {
    const response = await put(profileBody());

    expect(response.statusCode).toBe(200);
    const stored = response.json();
    expect(stored.profileVersion).toMatch(/^v1:[0-9a-f]{16}$/);
    expect(stored.id).toBeTruthy();
    expect(await prisma.candidateProfile.count({ where: { userId } })).toBe(1);
  });

  it('publishes a revision that labels exactly the published facts', async () => {
    const stored = (await put(profileBody())).json();

    const { profileVersion, id, userId: owner, ...facts } = stored;
    // ENG-012: a stored JobMatch names this revision, so it must identify the facts it labels.
    expect(profileVersion).toBe(profileVersionOf(facts as UnversionedCandidateProfile));
    expect(owner).toBe(userId);
    expect(id).toBeTruthy();
  });

  it('canonicalises a salary floor before deriving the revision, so the version labels what is stored', async () => {
    const stored = (
      await put(
        profileBody({
          salaryPreference: { min: '50000', currency: 'ETB', period: 'MONTH', requireDisclosed: false },
        }),
      )
    ).json();

    // The table's scale is DECIMAL(14,2): `50000` is stored as `50000.00`, so the version has to
    // be derived from the canonical amount, not from the shorter string the client sent.
    expect(stored.salaryPreference.min).toBe('50000.00');
    const { profileVersion, id, userId: owner, ...facts } = stored;
    expect(profileVersion).toBe(profileVersionOf(facts as UnversionedCandidateProfile));
  });

  it('replaces the whole profile, removing what the candidate no longer claims', async () => {
    await put(profileBody());
    const replaced = await put(
      profileBody({ skills: [], targetRoles: [], locationPreferences: [], experienceYears: null }),
    );

    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({ skills: [], targetRoles: [], locationPreferences: [] });
    expect(replaced.json().experienceYears).toBeNull();
    // The repository replaces child rows rather than merging: no stale skill survives.
    expect(await prisma.candidateSkill.count()).toBe(0);
  });

  it('requests a PROFILE_CHANGED re-score per enabled source', async () => {
    await put(profileBody());

    const tasks = await backfillTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].dedupeKey).toBe(`match.score:source:${sourceId}`);
    expect(tasks[0].payload).toMatchObject({
      sourceId,
      sourceRunId: null,
      trigger: 'PROFILE_CHANGED',
    });
  });

  it('requests nothing when the profile content did not change', async () => {
    await put(profileBody());
    // Make the first task terminal, so a second request would be visible rather than coalesced.
    await prisma.workTask.updateMany({ data: { status: 'SUCCEEDED' } });

    const unchanged = await put(profileBody());

    expect(unchanged.statusCode).toBe(200);
    expect(await backfillTasks()).toHaveLength(1);
  });

  it('coalesces a second change with the re-score already pending', async () => {
    await put(profileBody());
    const changed = await put(profileBody({ experienceYears: 6 }));

    expect(changed.statusCode).toBe(200);
    // One task per source under the source-scoped key: a pending backfill is not stacked on.
    expect(await backfillTasks()).toHaveLength(1);
    expect(await prisma.candidateProfile.count({ where: { userId } })).toBe(1);
  });

  it('rejects a body that does not state the whole profile, and stores nothing', async () => {
    const { targetRoles: _omitted, ...partial } = profileBody();

    const response = await put(partial);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.candidateProfile.count()).toBe(0);
  });

  it('rejects a verdict the domain does not have, and an out-of-scale amount', async () => {
    const badEnum = await put(profileBody({ remotePreference: 'SOMETIMES' }));
    const badAmount = await put(
      profileBody({
        salaryPreference: { min: '50000.005', currency: 'ETB', period: 'MONTH', requireDisclosed: false },
      }),
    );

    expect(badEnum.statusCode).toBe(400);
    expect(badAmount.statusCode).toBe(400);
    expect(await prisma.candidateProfile.count()).toBe(0);
    expect(await backfillTasks()).toHaveLength(0);
  });

  it('keeps one profile per candidate and does not leak another candidate’s revision', async () => {
    const other = await prisma.user.create({ data: { email: `other-${Date.now()}@example.test` } });
    await put(profileBody());
    await app.inject({
      method: 'PUT',
      url: `/api/profile?userId=${other.id}`,
      payload: profileBody({ experienceYears: 12 }),
    });

    const mine = (await get()).json();
    const theirs = (
      await app.inject({ method: 'GET', url: `/api/profile?userId=${other.id}` })
    ).json();

    expect(mine.experienceYears).toBe(5);
    expect(theirs.experienceYears).toBe(12);
    expect(mine.profileVersion).not.toBe(theirs.profileVersion);
  });
});
