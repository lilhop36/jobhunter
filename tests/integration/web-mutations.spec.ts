import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import {
  EmploymentType,
  LocationCategory,
  RelocationPreference,
  RemotePreference,
  SalaryPeriod,
  SkillEvidence,
} from '@domain/enums';
import type { UnversionedCandidateProfile } from '@domain/matching';
import { asDecimalAmount, asProbability } from '@domain/types';
import { PrismaCandidateProfileRepository } from '@infrastructure/ingestion/prisma-candidate-profile-repository';
import {
  applyTestMigrations,
  createTestPrismaClient,
  truncateAll,
} from '../support/db';
import { testApiConfig } from '../support/api';
import { cookieHeader, csrfFrom, signIn, type Cookies } from '../support/web';
import { buildApi } from '../../apps/api/main';

/**
 * The mutating web pages (SRS 3.1; ADR-0009, ADR-0011): `/profile`, `/settings`,
 * `/settings/telegram`.
 *
 * What is pinned here is what a form owes that a JSON route does not: a session the browser had to
 * sign in for, a CSRF token a forged cross-origin POST cannot produce, validation that rejects
 * rather than silently stores a different profile, and a save that takes the same path as
 * `PUT /api/profile` (same repository, same re-score request).
 */

const prisma = createTestPrismaClient();
const profiles = new PrismaCandidateProfileRepository(prisma);

let app: FastifyInstance;
let appPrisma: PrismaClient;
let counter = 0;
let userId: string;
let profileVersion: string;
let cookies: Cookies;

const BOT_USERNAME = 'jobhunterethiobot';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);

  const user = await prisma.user.create({
    data: { email: `mutations-${Date.now()}-${counter++}@example.test` },
    select: { id: true },
  });
  userId = user.id;
  profileVersion = (await profiles.saveForUser({ userId, profile: profileFixture() })).profileVersion;

  const api = await buildApi(
    testApiConfig({ TELEGRAM_BOT_USERNAME: BOT_USERNAME }),
  );
  app = api.app;
  appPrisma = api.prisma;
  await app.ready();

  cookies = await signIn(app, userId);
});

afterEach(async () => {
  await app.close();
  await appPrisma.$disconnect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function profileFixture(): UnversionedCandidateProfile {
  return {
    experienceYears: 5,
    remotePreference: RemotePreference.NO_PREFERENCE,
    relocationPreference: RelocationPreference.UNDECIDED,
    salaryPreference: {
      min: asDecimalAmount('50000.00'),
      currency: 'ETB',
      period: SalaryPeriod.MONTH,
      requireDisclosed: false,
    },
    employmentPreferences: [EmploymentType.FULL_TIME],
    skills: [
      { canonicalSkill: 'TypeScript', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(0.9) },
    ],
    targetRoles: [{ title: 'Backend Engineer', aliases: [] }],
    locationPreferences: [{ category: LocationCategory.ADDIS_ABABA, text: null }],
  };
}

const get = (url: string, as: Cookies = cookies) =>
  app.inject({
    method: 'GET',
    url,
    headers: { cookie: cookieHeader(as) },
  });

const post = (url: string, payload: string, as: Cookies = cookies) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(as),
    },
    payload,
  });

async function createSource(name = `mutations-src-${counter++}`): Promise<string> {
  const source = await prisma.jobSource.create({
    data: { name, adapterType: 'FAKE', adapterVersion: '1.0.0' },
    select: { id: true },
  });
  return source.id;
}

describe('session handshake', () => {
  it('renders the editor with the CSRF token of the session the browser signed in with', async () => {
    const response = await get('/profile');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<form method="post" action="/profile">');
    // The token is the one this session was issued, readable so the form can echo it; the session
    // cookie itself is HttpOnly and never rendered.
    expect(csrfFrom(response.body)).toBe(cookies.jh_csrf);
    expect(response.body).not.toContain(cookies.jh_session as string);
    expect(response.cookies).toEqual([]);
  });

  it('allows a same-origin form post and nothing else, in the page policy', async () => {
    const response = await get('/profile');

    const policy = String(response.headers['content-security-policy']);
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("default-src 'none'");
  });

  it('shows each session its own candidate once several are stored', async () => {
    const other = await prisma.user.create({ data: { email: `other-${counter++}@example.test` } });
    await profiles.saveForUser({
      userId: other.id,
      profile: { ...profileFixture(), experienceYears: 11 },
    });

    expect((await get('/profile')).body).toContain('value="5"');
    expect((await get('/profile', await signIn(app, other.id))).body).toContain('value="11"');
  });
});

describe('POST /profile', () => {
  it('refuses a save whose token does not match the session, and stores nothing', async () => {
    // The session is real, so this is the CSRF half alone: a cross-site form that rides the cookie
    // but cannot read the token out of the page it did not originate.
    const response = await post('/profile', '_csrf=not-the-token');

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('form token is missing or wrong');
    expect((await profiles.findForUser(userId))?.profileVersion).toBe(profileVersion);
  });

  it('refuses a save that names the candidate in its own body', async () => {
    // ADR-0011 removed `userId` from the page routes too, and a form that still sends one is told so
    // rather than quietly answered about the person who signed in.
    const response = await post('/profile', '_csrf=whatever&userId=0b6b5934-b42d-4b06-b203-5ddd4475d100');

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect((await profiles.findForUser(userId))?.profileVersion).toBe(profileVersion);
  });

  it('rejects an invalid field, shows the form again filled in, and stores nothing', async () => {
    const page = await get('/profile');

    const response = await post(
      '/profile',
      new URLSearchParams({
        _csrf: csrfFrom(page.body),
        experienceYears: 'lots',
        remotePreference: 'NO_PREFERENCE',
        relocationPreference: 'UNDECIDED',
        skills: '',
        targetRoles: '',
        locationPreferences: '',
      }).toString(),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Experience years must be a whole number');
    expect(response.body).toContain('value="lots"');
    expect((await profiles.findForUser(userId))?.profileVersion).toBe(profileVersion);
  });

  it('saves the submitted profile and requests the same re-score as the JSON route', async () => {
    await createSource();
    const page = await get('/profile');

    const response = await post(
      '/profile',
      new URLSearchParams({
        _csrf: csrfFrom(page.body),
        experienceYears: '9',
        remotePreference: 'REMOTE_PREFERRED',
        relocationPreference: 'WILLING',
        salaryMin: '60000',
        salaryCurrency: 'ETB',
        salaryPeriod: 'MONTH',
        skills: 'Docker | RELATED_SKILL | 0.5',
        targetRoles: 'Platform Engineer',
        locationPreferences: 'ETHIOPIA_REMOTE | anywhere',
      }).toString(),
    );

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/dashboard');

    const stored = await profiles.findForUser(userId);
    expect(stored?.profileVersion).not.toBe(profileVersion);
    expect(stored?.profile.experienceYears).toBe(9);
    expect(stored?.profile.remotePreference).toBe(RemotePreference.REMOTE_PREFERRED);
    expect(stored?.profile.salaryPreference?.min).toBe('60000.00');
    expect(stored?.profile.skills).toEqual([
      { canonicalSkill: 'Docker', skillType: SkillEvidence.RELATED_SKILL, confidence: 0.5 },
    ]);

    const tasks = await prisma.workTask.findMany({ select: { payload: true } });
    expect(tasks).toHaveLength(1);
    expect((tasks[0]?.payload as { trigger?: string }).trigger).toBe('PROFILE_CHANGED');
  });

  it('enqueues nothing when the saved profile is unchanged', async () => {
    await createSource();
    const page = await get('/profile');

    // Submit the stored profile back, unchanged.
    const response = await post(
      '/profile',
      new URLSearchParams({
        _csrf: csrfFrom(page.body),
        experienceYears: '5',
        remotePreference: 'NO_PREFERENCE',
        relocationPreference: 'UNDECIDED',
        salaryMin: '50000.00',
        salaryCurrency: 'ETB',
        salaryPeriod: 'MONTH',
        employmentPreferences: 'FULL_TIME',
        skills: 'TypeScript | EXACT_MATCH | 0.9',
        targetRoles: 'Backend Engineer',
        locationPreferences: 'ADDIS_ABABA',
      }).toString(),
    );

    expect(response.statusCode).toBe(302);
    expect((await profiles.findForUser(userId))?.profileVersion).toBe(profileVersion);
    expect(await prisma.workTask.count()).toBe(0);
  });
});

describe('/settings/telegram', () => {
  it('shows the linking form when the bot is configured', async () => {
    const response = await get('/settings/telegram');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`https://t.me/${BOT_USERNAME}`);
    expect(response.body).toContain('action="/settings/telegram"');
  });

  it('mints a one-use link for the signed-in candidate and sends the browser to Telegram', async () => {
    const page = await get('/settings/telegram');

    const response = await post('/settings/telegram', `_csrf=${csrfFrom(page.body)}`);

    expect(response.statusCode).toBe(302);
    expect(String(response.headers.location)).toMatch(
      new RegExp(`^https://t\\.me/${BOT_USERNAME}\\?start=`),
    );

    const tokens = await prisma.telegramLinkToken.findMany({ select: { userId: true, usedAt: true } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.userId).toBe(userId);
    expect(tokens[0]?.usedAt).toBeNull();
  });

  it('refuses to mint a link without a matching token', async () => {
    await get('/settings/telegram');

    const response = await post('/settings/telegram', '_csrf=wrong');

    expect(response.statusCode).toBe(403);
    expect(await prisma.telegramLinkToken.count()).toBe(0);
  });

  it('mints for the session, not for a candidate the form names', async () => {
    const victim = await prisma.user.create({ data: { email: `victim-${counter++}@example.test` } });
    await profiles.saveForUser({ userId: victim.id, profile: profileFixture() });

    const response = await post(
      '/settings/telegram',
      new URLSearchParams({ _csrf: cookies.jh_csrf as string, userId: victim.id }).toString(),
    );

    expect(response.statusCode).toBe(400);
    expect(await prisma.telegramLinkToken.count()).toBe(0);
  });

  it('offers the settings index a link to the telegram page', async () => {
    const response = await get('/settings');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('href="/settings/telegram"');
  });
});