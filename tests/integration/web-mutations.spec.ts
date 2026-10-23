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
  requireTestDatabaseUrl,
  truncateAll,
} from '../support/db';
import { parseApiConfig } from '../../apps/api/config';
import { buildApi } from '../../apps/api/main';

/**
 * The mutating web pages (SRS 3.1; ADR-0009): `/profile`, `/settings`, `/settings/telegram`,
 * `/login`, `/logout`.
 *
 * What is pinned here is what a form owes that a JSON route does not: a session the browser is
 * given on first render, a CSRF token a forged cross-origin POST cannot produce, validation that
 * rejects rather than silently stores a different profile, and a save that takes the same path as
 * `PUT /api/profile` (same repository, same re-score request).
 */

const prisma = createTestPrismaClient();
const profiles = new PrismaCandidateProfileRepository(prisma);

let app: FastifyInstance;
let appPrisma: PrismaClient;
let counter = 0;
let userId: string;
let profileVersion: string;

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
    parseApiConfig({
      ...process.env,
      DATABASE_URL: requireTestDatabaseUrl(),
      API_HOST: '127.0.0.1',
      TELEGRAM_BOT_USERNAME: BOT_USERNAME,
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

type Cookies = Record<string, string>;

function cookieHeader(cookies: Cookies): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function cookiesOf(response: { cookies: Array<{ name: string; value: string }> }): Cookies {
  const jar: Cookies = {};
  for (const cookie of response.cookies) jar[cookie.name] = cookie.value;
  return jar;
}

/** The hidden CSRF field of the rendered form. */
function csrfFrom(body: string): string {
  return /name="_csrf" value="([^"]*)"/.exec(body)?.[1] ?? '';
}

const get = (url: string, cookies?: Cookies) =>
  app.inject({
    method: 'GET',
    url,
    ...(cookies === undefined ? {} : { headers: { cookie: cookieHeader(cookies) } }),
  });

const post = (url: string, payload: string, cookies?: Cookies) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookies === undefined ? {} : { cookie: cookieHeader(cookies) }),
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
  it('renders the editor and gives the browser a session and a CSRF token', async () => {
    const response = await get('/profile');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<form method="post" action="/profile">');

    const cookies = cookiesOf(response);
    expect(cookies.jh_session).toBeTruthy();
    expect(cookies.jh_csrf).toBeTruthy();
    // The form echoes the readable CSRF cookie, and the session cookie itself is never rendered.
    expect(csrfFrom(response.body)).toBe(cookies.jh_csrf);
    expect(response.body).not.toContain(cookies.jh_session as string);
  });

  it('allows a same-origin form post and nothing else, in the page policy', async () => {
    const response = await get('/profile');

    const policy = String(response.headers['content-security-policy']);
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("default-src 'none'");
  });

  it('signs in through the chooser and then stops asking which candidate', async () => {
    const other = await prisma.user.create({ data: { email: `other-${counter++}@example.test` } });
    await profiles.saveForUser({
      userId: other.id,
      profile: { ...profileFixture(), experienceYears: 11 },
    });

    const chooser = await get('/dashboard');
    expect(chooser.body).toContain(`/login?userId=${other.id}`);

    const login = await get(`/login?userId=${other.id}`);
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe('/dashboard');
    expect(cookiesOf(login).jh_session).toBeTruthy();

    const dashboard = await get('/dashboard', cookiesOf(login));
    expect(dashboard.body).not.toContain('Choose a candidate');

    const profile = await get('/profile', cookiesOf(login));
    expect(profile.body).toContain('value="11"');
  });

  it('clears the session on logout, so the chooser returns', async () => {
    const other = await prisma.user.create({ data: { email: `other-${counter++}@example.test` } });
    await profiles.saveForUser({ userId: other.id, profile: profileFixture() });

    // With two candidates, signing in is what makes the dashboard stop asking.
    const cookies = cookiesOf(await get(`/login?userId=${userId}`));
    expect((await get('/dashboard', cookies)).body).not.toContain('Choose a candidate');

    const logout = await get('/logout', cookies);
    expect(logout.statusCode).toBe(302);
    expect(logout.headers.location).toBe('/login');
    expect(JSON.stringify(logout.headers['set-cookie'])).toContain('Max-Age=0');

    // The cookie is gone from the session store, not merely re-sent.
    expect((await get('/dashboard', cookies)).body).toContain('Choose a candidate');
  });
});

describe('POST /profile', () => {
  it('refuses a save without a session or a matching token, and stores nothing', async () => {
    const page = await get('/profile');
    const cookies = cookiesOf(page);

    const noSession = await post('/profile', '_csrf=whatever');
    const wrongToken = await post('/profile', '_csrf=not-the-token', cookies);

    expect(noSession.statusCode).toBe(403);
    expect(wrongToken.statusCode).toBe(403);
    expect((await profiles.findForUser(userId))?.profileVersion).toBe(profileVersion);
  });

  it('rejects an invalid field, shows the form again filled in, and stores nothing', async () => {
    const page = await get('/profile');
    const cookies = cookiesOf(page);

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
      cookies,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Experience years must be a whole number');
    expect(response.body).toContain('value="lots"');
    expect((await profiles.findForUser(userId))?.profileVersion).toBe(profileVersion);
  });

  it('saves the submitted profile and requests the same re-score as the JSON route', async () => {
    await createSource();
    const page = await get('/profile');
    const cookies = cookiesOf(page);

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
      cookies,
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
    const cookies = cookiesOf(page);

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
      cookies,
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
    const cookies = cookiesOf(page);

    const response = await post('/settings/telegram', `_csrf=${csrfFrom(page.body)}`, cookies);

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
    const page = await get('/settings/telegram');

    const response = await post('/settings/telegram', '_csrf=wrong', cookiesOf(page));

    expect(response.statusCode).toBe(403);
    expect(await prisma.telegramLinkToken.count()).toBe(0);
  });

  it('offers the settings index a link to the telegram page', async () => {
    const response = await get('/settings');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('href="/settings/telegram"');
  });
});