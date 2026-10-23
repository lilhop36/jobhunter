import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  EmploymentType,
  LocationCategory,
  RelocationPreference,
  RemotePreference,
  SalaryPeriod,
  SkillEvidence,
} from '@domain/enums';
import { MATCHER_VERSION } from '@domain/matching';
import { NOTIFICATION_THRESHOLDS_V1 } from '@domain/notification';
import type { UnversionedCandidateProfile } from '@domain/matching';
import { asDecimalAmount, asPercent, asProbability } from '@domain/types';
import { PrismaCandidateProfileRepository } from '@infrastructure/ingestion/prisma-candidate-profile-repository';
import { PrismaJobMatchRepository } from '@infrastructure/ingestion/prisma-job-match-repository';
import {
  applyTestMigrations,
  createTestPrismaClient,
  requireTestDatabaseUrl,
  truncateAll,
} from '../support/db';
import { parseApiConfig } from '../../apps/api/config';
import { buildApi } from '../../apps/api/main';

/**
 * The read-only web pages (SRS 3.1, ADR-0007).
 *
 * What is pinned here is what a browser page owes that a JSON route does not: untrusted job text
 * is escaped (job titles and descriptions come from hostile sources), a stored URL only becomes a
 * link when it is http(s), unknown values stay visibly unknown rather than blank, the pages carry
 * the structural accessibility the SRS asks for, and none of them ships a script or an asset.
 */

const prisma = createTestPrismaClient();

let app: FastifyInstance;
let appPrisma: PrismaClient;
let counter = 0;
let userId: string;
let profileVersion: string;

const matches = new PrismaJobMatchRepository(prisma);
const profiles = new PrismaCandidateProfileRepository(prisma);

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);

  const user = await prisma.user.create({
    data: { email: `web-${Date.now()}-${counter++}@example.test` },
    select: { id: true },
  });
  userId = user.id;
  profileVersion = (
    await profiles.saveForUser({ userId, profile: profileFixture() })
  ).profileVersion;

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

async function createSource(name = `web-src-${counter++}`): Promise<string> {
  const source = await prisma.jobSource.create({
    data: { name, adapterType: 'FAKE', adapterVersion: '1.0.0' },
    select: { id: true },
  });
  return source.id;
}

async function createJob(
  overrides: Partial<Prisma.JobUncheckedCreateInput> = {},
  sourceId?: string,
): Promise<string> {
  const job = await prisma.job.create({
    data: {
      sourceId: sourceId ?? (await createSource()),
      identityKey: `web-identity-${counter++}`,
      descriptionQuality: 'SUFFICIENT',
      title: 'Backend Engineer',
      company: 'Acme',
      ...overrides,
    },
    select: { id: true },
  });
  return job.id;
}

async function createMatch(jobId: string): Promise<string> {
  const inputHash = `web-hash-${counter++}`;
  await matches.saveIfChanged({
    userId,
    jobId,
    profileVersion,
    inputHash,
    scoredAt: new Date('2026-10-19T10:00:00.000Z'),
    match: {
      score: asPercent(72),
      confidence: asPercent(55),
      factors: {
        role: asPercent(80),
        skills: null,
        experience: asPercent(70),
        location: asPercent(60),
        employment: asPercent(100),
        freshness: asPercent(90),
        salary: null,
      },
      matchedSkills: ['TypeScript'],
      missingSkills: [],
      uncertainSkills: ['Docker'],
      matchedEvidence: ['Role title matches the target role'],
      missingEvidence: [],
      uncertainEvidence: ['Salary was not disclosed'],
      explanation: 'Role and experience align with the profile.',
      matcherVersion: MATCHER_VERSION,
    },
  });
  const stored = await matches.findByInput({
    userId,
    jobId,
    matcherVersion: MATCHER_VERSION,
    inputHash,
  });
  if (stored === null) throw new Error('match was not stored');
  return stored.id;
}

const get = (url: string) => app.inject({ method: 'GET', url });

describe('page shell', () => {
  it('sends / to the dashboard', async () => {
    const response = await get('/');

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/dashboard');
  });

  it('serves HTML with a policy that forbids scripts and assets', async () => {
    const response = await get('/dashboard');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html; charset=utf-8');
    expect(String(response.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('carries the structural accessibility the SRS asks for, and no client script', async () => {
    // A page with a table, so the header semantics exist to be checked.
    await createJob();
    const body = (await get('/jobs')).body;

    expect(body).toContain('<html lang="en">');
    expect(body).toContain('class="skip" href="#main"');
    expect(body).toContain('<main id="main">');
    expect(body).toContain('<th scope="col">');
    expect(body.match(/<h1>/g)).toHaveLength(1);
    // Low bandwidth: the page is the document. No script, no stylesheet request, no images.
    expect(body).not.toContain('<script');
    expect(body).not.toContain('<link rel=');
    expect(body).not.toContain('<img');
  });
});

describe('GET /dashboard', () => {
  it('explains the empty state when no candidate profile exists', async () => {
    await truncateAll(prisma);

    const response = await get('/dashboard');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('No candidate profile yet');
    expect(response.body).toContain('npm run seed:candidate');
  });

  it('prioritises best matches, high confidence, notification status and source health', async () => {
    const jobId = await createJob({ title: 'Senior Backend Engineer' });
    const matchId = await createMatch(jobId);
    await prisma.notificationOutbox.create({
      data: {
        userId,
        jobId,
        jobMatchId: matchId,
        notificationType: 'NEW_MATCH',
        event: 'NEW_MATCH',
        payload: {},
      },
    });

    const response = await get('/dashboard');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Best matches');
    expect(response.body).toContain('Senior Backend Engineer');
    expect(response.body).toContain(`href="/matches/${matchId}"`);
    expect(response.body).toContain('High-confidence matches');
    expect(response.body).toContain(`Confidence at or above ${NOTIFICATION_THRESHOLDS_V1.minConfidence}`);
    expect(response.body).toContain('Notification status');
    expect(response.body).toContain('PENDING');
    expect(response.body).toContain('Source health');
    expect(response.body).toContain('Skills');
    // The unknown factor is named, not silently dropped: it is why the confidence is not higher.
    expect(response.body).toContain('Factors without evidence');
  });

  it('offers a choice instead of assuming one candidate when several profiles exist', async () => {
    const other = await prisma.user.create({ data: { email: `other-${counter++}@example.test` } });
    await profiles.saveForUser({ userId: other.id, profile: profileFixture() });

    const response = await get('/dashboard');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Choose a candidate');
    // Choosing is the login (ADR-0009), so the links establish a session rather than just
    // re-render the same page with a query parameter.
    expect(response.body).toContain(`/login?userId=${userId}`);
    expect(response.body).toContain(`/login?userId=${other.id}`);
  });

  it('answers 404 for a candidate id that has no profile', async () => {
    const response = await get('/dashboard?userId=00000000-0000-4000-8000-000000000000');

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('No profile exists for that candidate');
  });
});

describe('jobs pages', () => {
  it('lists jobs and pages with a cursor link', async () => {
    const sourceId = await createSource();
    await prisma.job.createMany({
      data: Array.from({ length: 26 }, (_unused, index) => ({
        sourceId,
        identityKey: `bulk-${counter++}-${index}`,
        descriptionQuality: 'SUFFICIENT' as const,
        title: `Bulk job ${index}`,
      })),
    });

    const first = await get('/jobs');

    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('Bulk job');
    expect(first.body).toContain('Next page');

    const nextUrl = /href="(\/jobs\?cursor=[^"]+)"/.exec(first.body)?.[1];
    expect(nextUrl).toBeTruthy();

    const second = await get(nextUrl as string);
    expect(second.statusCode).toBe(200);
    expect(second.body).not.toContain('Next page');
  });

  it('shows the job body, its salary, its application path and its provenance', async () => {
    const jobId = await createJob({
      title: 'Data Engineer',
      description: 'Build the pipeline.',
      salaryType: 'RANGE',
      salaryMin: '50000.00',
      salaryMax: '70000.00',
      salaryCurrency: 'ETB',
      salaryPeriod: 'MONTH',
      applicationMethod: 'ONLINE_URL',
      applyUrl: 'https://acme.test/apply',
      canonicalUrl: 'https://acme.test/jobs/1',
      provenance: {
        title: { provenance: 'SOURCE', conversionMethod: null, evidence: 'Data Engineer' },
        salaryMin: {
          provenance: 'DETERMINISTIC',
          conversionMethod: 'ETHIOPIAN_SALARY_V1',
          evidence: '50,000 ETB',
        },
      },
    });

    const response = await get(`/jobs/${jobId}`);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Build the pipeline.');
    expect(response.body).toContain('50000.00 – 70000.00 ETB per month');
    expect(response.body).toContain('href="https://acme.test/apply"');
    // SRS 5.4: the origin of a value stays distinguishable, with the evidence it came from.
    expect(response.body).toContain('SOURCE');
    expect(response.body).toContain('DETERMINISTIC');
    expect(response.body).toContain('ETHIOPIAN_SALARY_V1');
    expect(response.body).toContain('50,000 ETB');
  });

  it('says so when no provenance was recorded', async () => {
    const jobId = await createJob({});

    const response = await get(`/jobs/${jobId}`);

    expect(response.body).toContain('No provenance was recorded for this job');
  });

  it('escapes hostile stored text and refuses to link a non-web URL', async () => {
    const jobId = await createJob({
      title: `<script>alert('title')</script>`,
      company: `"><img src=x onerror=alert(1)>`,
      description: `line one</p><script>alert('description')</script>`,
      canonicalUrl: `javascript:alert('href')`,
      applicationMethod: 'ONLINE_URL',
      applyUrl: `javascript:alert('apply')`,
    });

    const detail = await get(`/jobs/${jobId}`);
    const list = await get('/jobs');

    for (const body of [detail.body, list.body]) {
      expect(body).not.toContain('<script');
      expect(body).not.toContain('<img');
      expect(body).not.toContain('href="javascript:');
      expect(body).toContain('&lt;script&gt;');
    }
    expect(detail.body).toContain('&quot;&gt;&lt;img');
    expect(detail.body).toContain('not a web link');
  });

  it('answers 404 for an unknown job and 400 for an id that is not a UUID', async () => {
    const missing = await get('/jobs/00000000-0000-4000-8000-000000000000');
    const malformed = await get('/jobs/not-a-uuid');

    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('That job was not found');
    expect(malformed.statusCode).toBe(400);
  });
});

describe('matches pages', () => {
  it('shows the factor breakdown, the explanation and the evidence for one match', async () => {
    const jobId = await createJob({ title: 'Platform Engineer', company: 'Acme' });
    const matchId = await createMatch(jobId);

    const response = await get(`/matches/${matchId}`);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Platform Engineer');
    expect(response.body).toContain('72 / 100');
    expect(response.body).toContain('55 / 100');
    expect(response.body).toContain('Role and experience align');
    expect(response.body).toContain('TypeScript');
    expect(response.body).toContain('Docker');
    expect(response.body).toContain('Salary was not disclosed');
    expect(response.body).toContain(`href="/jobs/${jobId}"`);
    // A factor with no evidence is a stated fact, not a zero.
    expect(response.body).toContain('<span class="unknown">unknown</span>');
  });

  it('answers 404 for an unknown match and 400 for a malformed one', async () => {
    const missing = await get('/matches/00000000-0000-4000-8000-000000000000');
    const malformed = await get('/matches/not-a-uuid');

    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('That match was not found');
    expect(malformed.statusCode).toBe(400);
  });

  it('rejects a cursor that belongs to another page', async () => {
    const response = await get('/jobs?cursor=not-a-cursor');

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('not valid');
  });
});
