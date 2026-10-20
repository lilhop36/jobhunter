import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { HealthStatus, SourceRunStatus, SourceRunTrigger } from '@domain/enums';
import { PrismaWorkTaskRepository } from '@infrastructure/work-tasks/prisma-work-task-repository';
import { SOURCE_COLLECTION_TASK_TYPE, sourceCollectionDedupeKey } from '@application/ingestion';
import {
  applyTestMigrations,
  createTestPrismaClient,
  truncateAll,
  requireTestDatabaseUrl,
} from '../support/db';
import { buildApi } from '../../apps/api/main';
import { parseApiConfig } from '../../apps/api/config';

const prisma = createTestPrismaClient();
let app: FastifyInstance;
let appPrisma: PrismaClient;
let workTaskRepo: PrismaWorkTaskRepository;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);
  workTaskRepo = new PrismaWorkTaskRepository(prisma);

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

describe('API /api/sources endpoints', () => {
  // Helper to create a source with runs
  async function createSourceWithRuns(overrides: Partial<{
    name: string;
    enabled: boolean;
    healthStatus: HealthStatus;
    schedule: string | null;
    runs: Array<{
      status: SourceRunStatus;
      trigger: SourceRunTrigger;
      jobsDiscovered: number;
      jobsAccepted: number;
    }>;
  }> = {}) {
    const source = await prisma.jobSource.create({
      data: {
        name: overrides.name ?? `test-source-${Date.now()}`,
        adapterType: 'FAKE',
        adapterVersion: '1.0.0',
        enabled: overrides.enabled ?? true,
        schedule: overrides.schedule ?? null,
        healthStatus: overrides.healthStatus ?? HealthStatus.UNKNOWN,
        lastSuccessfulRunAt: null,
        lastErrorAt: null,
      },
    });

    if (overrides.runs) {
      // Newest first: index 0 gets the latest timestamp, so both `latestRun` and run-history
      // order are fixed by the array instead of by how fast the inserts happen to run.
      const base = Date.UTC(2026, 0, 1, 0, 0, 0);
      for (const [index, run] of overrides.runs.entries()) {
        const startedAt = new Date(base - index * 60_000);
        await prisma.sourceRun.create({
          data: {
            sourceId: source.id,
            status: run.status,
            trigger: run.trigger,
            startedAt,
            finishedAt: run.status === 'RUNNING' ? null : new Date(startedAt.getTime() + 1000),
            durationMs: run.status === 'RUNNING' ? null : 1000,
            jobsDiscovered: run.jobsDiscovered,
            jobsAccepted: run.jobsAccepted,
            jobsDuplicate: 0,
            jobsRejected: 0,
            undeduplicable: 0,
            fallbackIdentities: 0,
            parseFailures: 0,
            httpFailures: 0,
            unexpectedZeroResults: false,
            enrichmentScheduled: false,
            errorSummary: null,
          },
        });
      }
    }

    return source;
  }

  describe('GET /api/sources', () => {
    it('returns empty list when no sources exist', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/sources',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.sources).toEqual([]);
      expect(body.pagination.nextCursor).toBeNull();
    });

    it('lists enabled sources with health and latest run', async () => {
      await createSourceWithRuns({
        name: 'source-a',
        healthStatus: HealthStatus.HEALTHY,
        runs: [
          { status: SourceRunStatus.SUCCEEDED, trigger: SourceRunTrigger.SCHEDULE, jobsDiscovered: 5, jobsAccepted: 3 },
        ],
      });
      await createSourceWithRuns({
        name: 'source-b',
        healthStatus: HealthStatus.FAILING,
        runs: [
          { status: SourceRunStatus.FAILED, trigger: SourceRunTrigger.MANUAL, jobsDiscovered: 0, jobsAccepted: 0 },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/sources',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.sources).toHaveLength(2);
      expect(body.sources[0].name).toBe('source-a');
      expect(body.sources[0].healthStatus).toBe('HEALTHY');
      expect(body.sources[0].latestRun).not.toBeNull();
      expect(body.sources[0].latestRun?.status).toBe('SUCCEEDED');
      expect(body.sources[1].name).toBe('source-b');
      expect(body.sources[1].healthStatus).toBe('FAILING');
    });

    it('excludes disabled sources by default', async () => {
      await createSourceWithRuns({ name: 'enabled-source', enabled: true });
      await createSourceWithRuns({ name: 'disabled-source', enabled: false });

      const response = await app.inject({
        method: 'GET',
        url: '/api/sources',
      });

      const body = JSON.parse(response.body);
      expect(body.sources).toHaveLength(1);
      expect(body.sources[0].name).toBe('enabled-source');
    });

    it('includes disabled sources when includeDisabled=true', async () => {
      await createSourceWithRuns({ name: 'enabled-source', enabled: true });
      await createSourceWithRuns({ name: 'disabled-source', enabled: false });

      const response = await app.inject({
        method: 'GET',
        url: '/api/sources?includeDisabled=true',
      });

      const body = JSON.parse(response.body);
      expect(body.sources).toHaveLength(2);
    });

    it('filters by healthStatus', async () => {
      await createSourceWithRuns({ name: 'healthy', healthStatus: HealthStatus.HEALTHY });
      await createSourceWithRuns({ name: 'failing', healthStatus: HealthStatus.FAILING });
      await createSourceWithRuns({ name: 'degraded', healthStatus: HealthStatus.DEGRADED });

      const response = await app.inject({
        method: 'GET',
        url: '/api/sources?healthStatus=HEALTHY',
      });

      const body = JSON.parse(response.body);
      expect(body.sources).toHaveLength(1);
      expect(body.sources[0].name).toBe('healthy');
    });

    it('paginates with cursor and limit', async () => {
      for (let i = 0; i < 5; i++) {
        await createSourceWithRuns({ name: `source-${i.toString().padStart(2, '0')}` });
      }

      // First page
      const page1 = await app.inject({
        method: 'GET',
        url: '/api/sources?limit=2',
      });
      const body1 = JSON.parse(page1.body);
      expect(body1.sources).toHaveLength(2);
      expect(body1.pagination.nextCursor).not.toBeNull();

      // Second page
      const page2 = await app.inject({
        method: 'GET',
        url: `/api/sources?limit=2&cursor=${body1.pagination.nextCursor}`,
      });
      const body2 = JSON.parse(page2.body);
      expect(body2.sources).toHaveLength(2);
      expect(body2.pagination.nextCursor).not.toBeNull();

      // Third page
      const page3 = await app.inject({
        method: 'GET',
        url: `/api/sources?limit=2&cursor=${body2.pagination.nextCursor}`,
      });
      const body3 = JSON.parse(page3.body);
      expect(body3.sources).toHaveLength(1);
      expect(body3.pagination.nextCursor).toBeNull();

      // All pages combined should have 5 unique sources
      const allNames = [...body1.sources, ...body2.sources, ...body3.sources].map((s) => s.name).sort();
      expect(allNames).toEqual(['source-00', 'source-01', 'source-02', 'source-03', 'source-04']);
    });

    it('rejects invalid cursor with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/sources?cursor=invalid-base64!!',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid healthStatus with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/sources?healthStatus=INVALID',
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects limit > 100 with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/sources?limit=101',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/sources/:id', () => {
    it('returns source detail with health and latest run', async () => {
      const source = await createSourceWithRuns({
        name: 'detail-source',
        healthStatus: HealthStatus.HEALTHY,
        schedule: '0 */6 * * *',
        runs: [
          { status: SourceRunStatus.SUCCEEDED, trigger: SourceRunTrigger.SCHEDULE, jobsDiscovered: 10, jobsAccepted: 8 },
          { status: SourceRunStatus.SUCCEEDED, trigger: SourceRunTrigger.STARTUP, jobsDiscovered: 5, jobsAccepted: 4 },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/sources/${source.id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(source.id);
      expect(body.name).toBe('detail-source');
      expect(body.healthStatus).toBe('HEALTHY');
      expect(body.schedule).toBe('0 */6 * * *');
      expect(body.latestRun).not.toBeNull();
      expect(body.latestRun?.status).toBe('SUCCEEDED');
      expect(body.latestRun?.jobsDiscovered).toBe(10); // Most recent
    });

    it('returns 404 for unknown source', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/sources/00000000-0000-0000-0000-000000000000',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 for invalid UUID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/sources/not-a-uuid',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/sources/:id/runs', () => {
    it('returns paginated run history', async () => {
      const source = await createSourceWithRuns({
        name: 'run-source',
        runs: [
          { status: SourceRunStatus.SUCCEEDED, trigger: SourceRunTrigger.SCHEDULE, jobsDiscovered: 5, jobsAccepted: 4 },
          { status: SourceRunStatus.FAILED, trigger: SourceRunTrigger.MANUAL, jobsDiscovered: 0, jobsAccepted: 0 },
          { status: SourceRunStatus.PARTIAL, trigger: SourceRunTrigger.STARTUP, jobsDiscovered: 3, jobsAccepted: 2 },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/sources/${source.id}/runs`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.runs).toHaveLength(3);
      // Ordered by startedAt DESC: the first run in the fixture is the most recent.
      expect(body.runs[0].status).toBe('SUCCEEDED');
      expect(body.runs[1].status).toBe('FAILED');
      expect(body.runs[2].status).toBe('PARTIAL');
      expect(body.runs[0].trigger).toBe('SCHEDULE');
      expect(body.runs[1].trigger).toBe('MANUAL');
      expect(body.runs[2].trigger).toBe('STARTUP');
    });

    it('paginates with cursor', async () => {
      const source = await createSourceWithRuns({
        name: 'run-source-paginated',
        runs: Array.from({ length: 5 }, (_, i) => ({
          status: SourceRunStatus.SUCCEEDED,
          trigger: SourceRunTrigger.SCHEDULE,
          jobsDiscovered: i + 1,
          jobsAccepted: i + 1,
        })),
      });

      // First page
      const page1 = await app.inject({
        method: 'GET',
        url: `/api/sources/${source.id}/runs?limit=2`,
      });
      const body1 = JSON.parse(page1.body);
      expect(body1.runs).toHaveLength(2);
      expect(body1.pagination.nextCursor).not.toBeNull();

      // Second page
      const page2 = await app.inject({
        method: 'GET',
        url: `/api/sources/${source.id}/runs?limit=2&cursor=${body1.pagination.nextCursor}`,
      });
      const body2 = JSON.parse(page2.body);
      expect(body2.runs).toHaveLength(2);
      expect(body2.pagination.nextCursor).not.toBeNull();

      // Third page
      const page3 = await app.inject({
        method: 'GET',
        url: `/api/sources/${source.id}/runs?limit=2&cursor=${body2.pagination.nextCursor}`,
      });
      const body3 = JSON.parse(page3.body);
      expect(body3.runs).toHaveLength(1);
      expect(body3.pagination.nextCursor).toBeNull();
    });

    it('filters by status', async () => {
      const source = await createSourceWithRuns({
        name: 'filter-source',
        runs: [
          { status: SourceRunStatus.SUCCEEDED, trigger: SourceRunTrigger.SCHEDULE, jobsDiscovered: 5, jobsAccepted: 4 },
          { status: SourceRunStatus.FAILED, trigger: SourceRunTrigger.MANUAL, jobsDiscovered: 0, jobsAccepted: 0 },
          { status: SourceRunStatus.FAILED, trigger: SourceRunTrigger.SCHEDULE, jobsDiscovered: 0, jobsAccepted: 0 },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/sources/${source.id}/runs?status=FAILED`,
      });

      const body = JSON.parse(response.body);
      expect(body.runs).toHaveLength(2);
      expect(body.runs.every((r: any) => r.status === 'FAILED')).toBe(true);
    });

    it('filters by trigger', async () => {
      const source = await createSourceWithRuns({
        name: 'trigger-source',
        runs: [
          { status: SourceRunStatus.SUCCEEDED, trigger: SourceRunTrigger.SCHEDULE, jobsDiscovered: 5, jobsAccepted: 4 },
          { status: SourceRunStatus.SUCCEEDED, trigger: SourceRunTrigger.MANUAL, jobsDiscovered: 3, jobsAccepted: 2 },
          { status: SourceRunStatus.SUCCEEDED, trigger: SourceRunTrigger.STARTUP, jobsDiscovered: 1, jobsAccepted: 1 },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/sources/${source.id}/runs?trigger=MANUAL`,
      });

      const body = JSON.parse(response.body);
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0].trigger).toBe('MANUAL');
    });

    it('returns 404 for unknown source', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/sources/00000000-0000-0000-0000-000000000000/runs',
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 400 for invalid status filter', async () => {
      const source = await createSourceWithRuns({ name: 'test' });

      const response = await app.inject({
        method: 'GET',
        url: `/api/sources/${source.id}/runs?status=INVALID`,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /api/sources/:id/run', () => {
    it('enqueues a manual collection task and returns 202', async () => {
      const source = await createSourceWithRuns({ name: 'manual-source' });

      const response = await app.inject({
        method: 'POST',
        url: `/api/sources/${source.id}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.task).toBeDefined();
      expect(body.task.type).toBe(SOURCE_COLLECTION_TASK_TYPE);
      expect(body.task.status).toBe('PENDING');
      expect(body.task.attempts).toBe(0);
      expect(body.task.dedupeKey).toBe(sourceCollectionDedupeKey(source.id));
    });

    // Regression (found operating the stack live): these Fastify request-level errors used
    // to fall through to the generic 500 INTERNAL_ERROR, turning a caller mistake into an
    // apparent server failure.
    it('answers an unsupported media type with 415, not 500', async () => {
      const source = await createSourceWithRuns({ name: 'form-posted' });

      const response = await app.inject({
        method: 'POST',
        url: `/api/sources/${source.id}/run`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'userId=x',
      });

      expect(response.statusCode).toBe(415);
      expect(JSON.parse(response.body).error.code).toBe('VALIDATION_ERROR');
    });

    it('answers an empty JSON body with 400, not 500', async () => {
      const source = await createSourceWithRuns({ name: 'empty-json' });

      const response = await app.inject({
        method: 'POST',
        url: `/api/sources/${source.id}/run`,
        headers: { 'content-type': 'application/json' },
        payload: '',
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 409 SOURCE_DISABLED for a disabled source and enqueues nothing (ADR-0003)', async () => {
      const source = await createSourceWithRuns({ name: 'disabled-source', enabled: false });

      const response = await app.inject({
        method: 'POST',
        url: `/api/sources/${source.id}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      // Whole envelope, so the code, message and details cannot drift.
      expect(body.error).toEqual({
        code: 'SOURCE_DISABLED',
        message: 'Source is disabled',
        details: { sourceId: source.id },
      });

      const tasks = await prisma.workTask.findMany({
        where: { dedupeKey: sourceCollectionDedupeKey(source.id) },
      });
      expect(tasks).toEqual([]);
    });

    it('checks enablement before the active-run conflict (ADR-0003 guard order)', async () => {
      const source = await createSourceWithRuns({
        name: 'disabled-running-source',
        enabled: false,
        runs: [
          {
            status: SourceRunStatus.RUNNING,
            trigger: SourceRunTrigger.MANUAL,
            jobsDiscovered: 0,
            jobsAccepted: 0,
          },
        ],
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/sources/${source.id}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      // Both conditions hold; the disabled refusal is the one reported.
      expect(JSON.parse(response.body).error.code).toBe('SOURCE_DISABLED');
    });

    it('returns 404 for unknown source', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sources/00000000-0000-0000-0000-000000000000/run',
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 409 SOURCE_RUN_ACTIVE when a run is already active', async () => {
      const source = await createSourceWithRuns({
        name: 'active-source',
        runs: [{ status: SourceRunStatus.RUNNING, trigger: SourceRunTrigger.SCHEDULE, jobsDiscovered: 0, jobsAccepted: 0 }],
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/sources/${source.id}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('SOURCE_RUN_ACTIVE');
      expect(body.error.message).toContain('already running');
      expect(body.error.details).toEqual({ sourceId: source.id });
    });

    it('returns 409 when a PENDING task already exists (dedupeKey race)', async () => {
      const source = await createSourceWithRuns({ name: 'pending-source' });

      // Pre-create a PENDING task with the same dedupeKey
      await workTaskRepo.enqueue({
        type: SOURCE_COLLECTION_TASK_TYPE,
        payload: { sourceId: source.id, trigger: SourceRunTrigger.MANUAL },
        dedupeKey: sourceCollectionDedupeKey(source.id),
        maxAttempts: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/sources/${source.id}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('SOURCE_RUN_ACTIVE');
    });

    it('prevents concurrent manual requests from creating duplicate active runs', async () => {
      const source = await createSourceWithRuns({ name: 'concurrent-source' });

      // Fire two concurrent requests
      const [r1, r2] = await Promise.all([
        app.inject({ method: 'POST', url: `/api/sources/${source.id}/run`, payload: {} }),
        app.inject({ method: 'POST', url: `/api/sources/${source.id}/run`, payload: {} }),
      ]);

      // One should succeed (202), one should conflict (409)
      const statusCodes = [r1.statusCode, r2.statusCode].sort();
      expect(statusCodes).toEqual([202, 409]);

      // Only one task should exist
      const tasks = await prisma.workTask.findMany({
        where: { dedupeKey: sourceCollectionDedupeKey(source.id) },
      });
      expect(tasks).toHaveLength(1);
    });

    it('returns 400 for invalid source ID', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sources/not-a-uuid/run',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('Error format consistency', () => {
    it('all errors follow the SRS 3.4 envelope', async () => {
      const testCases = [
        { url: '/api/sources/not-a-uuid', expectedCode: 'VALIDATION_ERROR' },
        { url: '/api/sources/00000000-0000-0000-0000-000000000000', expectedCode: 'NOT_FOUND' },
        { url: '/api/sources?healthStatus=INVALID', expectedCode: 'VALIDATION_ERROR' },
      ];

      for (const tc of testCases) {
        const response = await app.inject({ method: 'GET', url: tc.url });
        const body = JSON.parse(response.body);
        expect(body.error).toBeDefined();
        expect(body.error.code).toBe(tc.expectedCode);
        expect(typeof body.error.message).toBe('string');
      }
    });
  });
});

describe('API startup and configuration', () => {
  it('rejects missing DATABASE_URL', () => {
    expect(() => parseApiConfig({})).toThrow('DATABASE_URL is required');
  });

  it('defaults host to 127.0.0.1 and port to 3001', () => {
    const config = parseApiConfig({ DATABASE_URL: 'postgresql://test' });
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3001);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseApiConfig({ DATABASE_URL: 'postgresql://test', API_PORT: '70000' })).toThrow(
      'API_PORT',
    );
  });

  it('health endpoint returns ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  });
});