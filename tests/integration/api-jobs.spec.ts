import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  applyTestMigrations,
  createTestPrismaClient,
  requireTestDatabaseUrl,
  truncateAll,
} from '../support/db';
import { parseApiConfig } from '../../apps/api/config';
import { buildApi } from '../../apps/api/main';

/**
 * The two job routes (SRS 3.4 `GET /api/jobs`, `GET /api/jobs/:id`; FR-011, SRS 5.4).
 *
 * What is pinned: discovery order with exact keyset paging (including rows written in the same
 * millisecond), filters that the caller asked for and only those, a read path that publishes what
 * is stored without deriving anything (UNKNOWN stays UNKNOWN, no salary stays null), exact money
 * as decimal strings, and a detail that carries the provenance the stored row holds.
 */

const prisma = createTestPrismaClient();

let app: FastifyInstance;
let appPrisma: PrismaClient;
let counter = 0;
let sourceId: string;
let otherSourceId: string;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);

  sourceId = await createSource();
  otherSourceId = await createSource();

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

async function createSource(): Promise<string> {
  const source = await prisma.jobSource.create({
    data: {
      name: `jobs-src-${Date.now()}-${counter++}`,
      adapterType: 'FAKE',
      adapterVersion: '1.0.0',
    },
    select: { id: true },
  });
  return source.id;
}

async function createJob(overrides: Partial<Prisma.JobUncheckedCreateInput> = {}): Promise<string> {
  const job = await prisma.job.create({
    data: {
      sourceId,
      identityKey: `identity-${counter++}`,
      // No default in the schema: description quality is always classified (Appendix E).
      descriptionQuality: 'SUFFICIENT',
      title: 'Backend Engineer',
      company: 'Acme',
      ...overrides,
    },
    select: { id: true },
  });
  return job.id;
}

const list = (query = '') => app.inject({ method: 'GET', url: `/api/jobs${query}` });
const detail = (id: string) => app.inject({ method: 'GET', url: `/api/jobs/${id}` });

describe('GET /api/jobs', () => {
  it('lists newest discovery first and names the source of each job', async () => {
    const older = await createJob({
      title: 'Older',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = await createJob({
      title: 'Newer',
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    const response = await list();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.jobs.map((job: { id: string }) => job.id)).toEqual([newer, older]);
    expect(body.jobs[0].sourceName).toMatch(/^jobs-src-/);
    expect(body.pagination.nextCursor).toBeNull();
  });

  it('pages by exact keyset, including rows written in the same millisecond', async () => {
    const instant = new Date('2026-03-01T12:00:00.000Z');
    const created = [];
    for (let index = 0; index < 3; index += 1) {
      created.push(await createJob({ createdAt: instant, title: `Same instant ${index}` }));
    }

    const first = (await list('?limit=2')).json();
    expect(first.jobs).toHaveLength(2);
    expect(first.pagination.nextCursor).toBeTruthy();

    const second = (
      await list(`?limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor)}`)
    ).json();
    expect(second.jobs).toHaveLength(1);

    const seen = [...first.jobs, ...second.jobs].map((job: { id: string }) => job.id);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(new Set(seen)).toEqual(new Set(created));
  });

  it('filters by source and lifecycle state, and hides nothing by default', async () => {
    const mine = await createJob({ title: 'Mine' });
    const theirs = await createJob({ sourceId: otherSourceId, title: 'Theirs' });
    const expired = await createJob({ title: 'Expired', lifecycleStatus: 'EXPIRED' });

    const all = (await list()).json().jobs.map((job: { id: string }) => job.id);
    // EXPIRED is published, not filtered: which states to render is the caller's decision.
    expect(all).toEqual(expect.arrayContaining([mine, theirs, expired]));

    const bySource = (await list(`?sourceId=${otherSourceId}`)).json().jobs;
    expect(bySource.map((job: { id: string }) => job.id)).toEqual([theirs]);

    const active = (await list('?lifecycleStatus=EXPIRED')).json().jobs;
    expect(active.map((job: { id: string }) => job.id)).toEqual([expired]);
    expect(active[0].lifecycleStatus).toBe('EXPIRED');
  });

  it('publishes what is stored, with no derived fields and no description', async () => {
    const id = await createJob({
      title: null,
      company: null,
      locationText: null,
      locationCategory: 'UNKNOWN',
      salaryType: 'NOT_DISCLOSED',
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      publishedAt: null,
      description: 'long body text',
    });

    const job = (await list()).json().jobs[0];

    expect(job.id).toBe(id);
    expect(job.title).toBeNull();
    expect(job.company).toBeNull();
    expect(job.locationCategory).toBe('UNKNOWN');
    expect(job.salaryType).toBe('NOT_DISCLOSED');
    expect(job.salaryMin).toBeNull();
    expect(job.publishedAt).toBeNull();
    // The list is the low-bandwidth view (SRS 3.1): the body belongs to the detail.
    expect(job).not.toHaveProperty('description');
    expect(job).not.toHaveProperty('provenance');
  });

  it('publishes money as an exact decimal string, as stored at the column scale', async () => {
    await createJob({
      salaryType: 'RANGE',
      salaryMin: new Prisma.Decimal('50000'),
      salaryMax: new Prisma.Decimal('70000.5'),
      salaryCurrency: 'ETB',
      salaryPeriod: 'MONTH',
    });

    const job = (await list()).json().jobs[0];

    expect(job.salaryMin).toBe('50000.00');
    expect(job.salaryMax).toBe('70000.50');
    expect(typeof job.salaryMin).toBe('string');
  });

  it('rejects an out-of-range page size, an unknown state and a foreign cursor', async () => {
    expect((await list('?limit=0')).statusCode).toBe(400);
    expect((await list('?limit=101')).statusCode).toBe(400);
    expect((await list('?lifecycleStatus=ARCHIVED')).statusCode).toBe(400);
    expect((await list(`?sourceId=not-a-uuid`)).statusCode).toBe(400);

    const foreign = Buffer.from(JSON.stringify({ score: 50, id: 'x' }), 'utf8').toString('base64url');
    const response = await list(`?cursor=${foreign}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/jobs/:id', () => {
  it('returns the body, the application path and the stored provenance', async () => {
    const provenance = {
      title: { provenance: 'SOURCE', conversionMethod: null, evidence: 'Backend Engineer' },
      salaryMin: {
        provenance: 'DETERMINISTIC',
        conversionMethod: 'ETHIOPIAN_SALARY_V1',
        evidence: '50,000 ETB/month',
      },
    };
    const id = await createJob({
      description: 'Full description',
      salaryType: 'EXACT',
      salaryMin: new Prisma.Decimal('50000'),
      salaryCurrency: 'ETB',
      salaryPeriod: 'MONTH',
      salaryConfidence: new Prisma.Decimal('0.900'),
      salaryEvidence: '50,000 ETB/month',
      publishedCalendar: 'ETHIOPIAN',
      originalPublishedDateText: 'Meskerem 5, 2019',
      publishedAt: new Date('2026-09-15T00:00:00.000Z'),
      dateConfidence: new Prisma.Decimal('0.750'),
      applicationMethod: 'ONLINE_URL',
      applyUrl: 'https://acme.test/apply',
      provenance,
    });

    const response = await detail(id);

    expect(response.statusCode).toBe(200);
    const job = response.json();
    expect(job).toMatchObject({
      id,
      description: 'Full description',
      salaryMin: '50000.00',
      salaryConfidence: 0.9,
      publishedCalendar: 'ETHIOPIAN',
      originalPublishedDateText: 'Meskerem 5, 2019',
      publishedAt: '2026-09-15T00:00:00.000Z',
      dateConfidence: 0.75,
      applicationMethod: 'ONLINE_URL',
      applyUrl: 'https://acme.test/apply',
      applyEmail: null,
    });
    // SRS 5.4 / ENG-003: the evidence a value came from stays readable beside the value.
    expect(job.provenance).toEqual(provenance);
  });

  it('answers 404 for a job that is not stored and 400 for an id that is not a UUID', async () => {
    const missing = await detail('00000000-0000-4000-8000-000000000000');
    const malformed = await detail('not-a-uuid');

    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('leaves provenance null when the row stores none, rather than inventing an empty map', async () => {
    const id = await createJob({});

    const job = (await detail(id)).json();

    expect(job.provenance).toBeNull();
  });
});
