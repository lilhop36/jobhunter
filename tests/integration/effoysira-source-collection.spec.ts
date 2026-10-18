import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { buildApi } from '../../apps/api/main';
import { parseApiConfig } from '../../apps/api/config';
import { createWorkerRuntime, type WorkerRuntime } from '../../apps/worker/runtime';
import type { WorkerConfig } from '../../apps/worker/config';
import {
  applyTestMigrations,
  createTestPrismaClient,
  requireTestDatabaseUrl,
  truncateAll,
} from '../support/db';

/**
 * The approved-source path end to end (SRS 7.2, Appendix E, ADR-0003/0004): a `JobSource`
 * row named after the approved registration, the API's manual-run endpoint, the worker's
 * *production* registry (`PRODUCTION_ADAPTERS`, not a test double), and the EffoySira
 * adapter collecting fixture HTML into RawJob + Job rows.
 *
 * There is no network: the adapter's HTTP is the global `fetch`, so the test stubs the
 * global with the same fixture HTML the unit tests use (live markup verified 2026-10-17).
 * Every other layer - the resolver match by `JobSource.name`, the registration's approved
 * declarations, the collection handler, persistence and dedupe - is the production one.
 */

const POST_1 = 'https://effoysira.com/msa-trading-vacancy-fresh-graduates/';
const POST_2 = 'https://effoysira.com/addis-bank-job-vacancy-2026/';

function listingPage(urls: string[]): string {
  return urls
    .map(
      (url) =>
        `<article><h2 class="entry-title"><a href="${url}" rel="bookmark">T</a></h2></article>`,
    )
    .join('\n');
}

function postPage(title: string): string {
  return `<html><head>
<meta property="article:published_time" content="2026-10-17T09:57:17+00:00" /></head><body>
<h1 class="page-title">${title}</h1>
<div class="entry-content is-layout-flow">
<p>${title} invites qualified applicants.</p>
<div class="ad-slot"><script>ad()</script></div>
<h4>Position 1: Junior Officer</h4>
<p>Location: Addis Ababa</p>
<p>Salary: 15,000 birr</p>
<p>How to Apply: send your CV to hr@example.com</p>
</div>
</body></html>`;
}

const stubbedFetch = (async (input: string | URL) => {
  const url = String(input);
  const routes: Record<string, string> = {
    'https://effoysira.com/category/job/': listingPage([POST_1, POST_2]),
    'https://effoysira.com/category/job/page/2/': listingPage([]),
    [POST_1]: `<html><head><meta property="article:published_time" content="2026-10-17T09:57:17+00:00" /></head><body><h1 class="page-title">MSA Trading Vacancy Fresh Graduates</h1><div class="entry-content is-layout-flow"><p>MSA Trading PLC would like to recruit professionals.</p><div class="code-block"><script>x</script></div><h4>Position 1: Junior Officer</h4><p>Location: Addis Ababa</p><p>Salary: 15,000 birr</p><p>How to Apply: send your CV to hr@example.com.</p></div></body></html>`,
    [POST_2]: postPage('Addis Bank Job Vacancy 2026'),
  };
  const route = routes[url];
  if (route === undefined) return new Response('not found', { status: 404 });
  return new Response(route, { status: 200 });
}) as unknown as typeof fetch;

const prisma = createTestPrismaClient();
let app: FastifyInstance;
let appPrisma: PrismaClient;
let runtime: WorkerRuntime | undefined;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);
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
  await runtime?.stop();
  runtime = undefined;
  vi.unstubAllGlobals();
  await app.close();
  await appPrisma.$disconnect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function workerConfig(): WorkerConfig {
  return {
    databaseUrl: requireTestDatabaseUrl(),
    workerId: 'effoysira-worker',
    leaseSeconds: 30,
    pollIntervalMs: 25,
    reaperIntervalMs: 60_000,
    schedulerIntervalMs: 60_000,
    staleRunSeconds: 5,
    // The real registration rate-limits at 800 ms between requests; the run must fit.
    acquisitionTimeoutMs: 15_000,
  };
}

async function waitForTask(taskId: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const task = await prisma.workTask.findUniqueOrThrow({ where: { id: taskId } });
    if (['SUCCEEDED', 'FAILED', 'DEAD_LETTER'].includes(task.status)) return task.status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the collection task');
}

describe('EffoySira approved-source collection (production registry, no network)', () => {
  it('resolves the row by name, collects fixture HTML, and persists RawJob + Job', async () => {
    // The row the operator seed creates (npm run seed:sources) - created inline here.
    const source = await prisma.jobSource.create({
      data: { name: 'EffoySira', adapterType: 'EFFOYSIRA_STATIC_HTML', adapterVersion: '1.0.0' },
    });

    // The adapter is built from the production registration and reads the global fetch,
    // so stubbing it here keeps the whole run offline.
    vi.stubGlobal('fetch', stubbedFetch);

    const response = await app.inject({ method: 'POST', url: `/api/sources/${source.id}/run` });
    expect(response.statusCode).toBe(202);
    const taskId = response.json().task.id as string;

    // No resolveAdapter override: the default is the production registry (ADR-0004).
    runtime = createWorkerRuntime(workerConfig(), {});
    await runtime.start();

    await expect(waitForTask(taskId)).resolves.toBe('SUCCEEDED');

    const raws = await prisma.rawJob.findMany({ where: { sourceId: source.id } });
    expect(raws).toHaveLength(2);
    const raw = raws.find((r) => r.sourceUrl === POST_1);
    expect(raw).not.toBeNull();
    expect(raw?.sourceJobIdentifier).toBeNull();
    expect(raw?.rawTitle).toBe('MSA Trading Vacancy Fresh Graduates');
    expect(raw?.rawLocation).toBe('Addis Ababa');
    expect(raw?.rawSalaryText).toBe('15,000 birr');
    expect(raw?.rawCompany).toBeNull();

    const jobs = await prisma.job.findMany({ where: { sourceId: source.id } });
    expect(jobs).toHaveLength(2);
    const job = jobs.find((j) => j.title === 'MSA Trading Vacancy Fresh Graduates');
    // canonicalizeUrl strips the trailing slash (unit tests compare via the normalizer).
    expect(job?.canonicalUrl).toBe('https://effoysira.com/msa-trading-vacancy-fresh-graduates');
    expect(job?.locationCategory).toBe('ADDIS_ABABA');
    expect(job?.company).toBeNull();
    expect(job?.salaryType).toBe('EXACT');
    expect(job?.salaryCurrency).toBe('ETB');
    expect(job?.applicationMethod).toBe('EMAIL');
    expect(job?.publishedCalendar).toBe('GREGORIAN');
  });
});
