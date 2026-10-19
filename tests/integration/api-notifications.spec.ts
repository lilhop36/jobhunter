import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { DescriptionQuality } from '@domain/enums';
import { PrismaNotificationFactsReader } from '@infrastructure/matching/prisma-notification-facts-reader';
import { applyTestMigrations, createTestPrismaClient, requireTestDatabaseUrl, truncateAll } from '../support/db';
import { parseApiConfig } from '../../apps/api/config';
import { buildApi } from '../../apps/api/main';

/**
 * The notification routes (SRS 3.4; SRS 5.2 `NotificationOutbox`; FR-016…FR-018, AC-017).
 *
 * What is pinned: the list is newest-first and paginates by keyset without skipping or repeating
 * a row; delivery state is published as stored, so "queued" cannot read as "delivered"; and the
 * feedback route records exactly one verdict per notification — the one write these routes allow,
 * and the one the SRS 3.2 eligibility rule later reads to suppress a rejected job.
 *
 * The last case is the loop closing: a verdict posted here is what
 * `PrismaNotificationFactsReader.rejected` reports, which is what makes SRS 3.2's
 * "not suppressed/rejected" predicate mean anything.
 */

const prisma = createTestPrismaClient();
const facts = new PrismaNotificationFactsReader(prisma);

const BASE = new Date('2026-10-19T12:00:00.000Z');

let app: FastifyInstance;
let appPrisma: PrismaClient;
let counter = 0;
let userId: string;
let otherUserId: string;
let jobId: string;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);

  const user = await prisma.user.create({
    data: { email: `api-notifications-${Date.now()}-${counter++}@example.test` },
    select: { id: true },
  });
  userId = user.id;
  otherUserId = (
    await prisma.user.create({
      data: { email: `api-notifications-other-${Date.now()}-${counter++}@example.test` },
      select: { id: true },
    })
  ).id;

  const source = await prisma.jobSource.create({
    data: { name: `src-${Date.now()}-${counter++}`, adapterType: 'FAKE', adapterVersion: '1.0.0' },
    select: { id: true },
  });
  jobId = (
    await prisma.job.create({
      data: {
        sourceId: source.id,
        identityKey: 'k1',
        descriptionQuality: DescriptionQuality.SUFFICIENT,
      },
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

async function reserve(
  overrides: Partial<{
    user: string;
    event: string;
    createdAt: Date;
    status: 'PENDING' | 'SENT' | 'FAILED' | 'PROCESSING';
    attemptCount: number;
    lastError: string | null;
    sentAt: Date | null;
  }> = {},
) {
  return prisma.notificationOutbox.create({
    data: {
      userId: overrides.user ?? userId,
      jobId,
      notificationType: 'NEW_MATCH',
      event: overrides.event ?? `NEW_MATCH-${counter++}`,
      payload: { score: 90, confidence: 54, explanation: 'Role and location match.' },
      status: overrides.status ?? 'PENDING',
      attemptCount: overrides.attemptCount ?? 0,
      lastError: overrides.lastError ?? null,
      sentAt: overrides.sentAt ?? null,
      createdAt: overrides.createdAt ?? BASE,
    },
    select: { id: true, createdAt: true },
  });
}

describe('GET /api/notifications', () => {
  it('lists newest first and publishes the stored delivery state', async () => {
    const older = await reserve({ createdAt: new Date(BASE.getTime() - 60_000) });
    const newer = await reserve({
      createdAt: BASE,
      status: 'SENT',
      attemptCount: 1,
      sentAt: BASE,
    });

    const response = await app.inject({ method: 'GET', url: `/api/notifications?userId=${userId}` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.notifications.map((row: { id: string }) => row.id)).toEqual([newer.id, older.id]);
    expect(body.notifications[0]).toMatchObject({
      userId,
      jobId,
      notificationType: 'NEW_MATCH',
      status: 'SENT',
      attemptCount: 1,
      sentAt: BASE.toISOString(),
      feedback: null,
    });
    // Not delivered yet: null `sentAt` is how a client tells queued from delivered.
    expect(body.notifications[1]).toMatchObject({ status: 'PENDING', attemptCount: 0, sentAt: null });
    // The stored SRS 3.2 content is published as written (SRS 5.2 `payload`).
    expect(body.notifications[0].payload).toMatchObject({ score: 90, confidence: 54 });
  });

  it('paginates by keyset without skipping or repeating a row', async () => {
    const first = await reserve({ createdAt: new Date(BASE.getTime() - 120_000) });
    const second = await reserve({ createdAt: new Date(BASE.getTime() - 60_000) });
    const third = await reserve({ createdAt: BASE });

    const pageOne = await app.inject({
      method: 'GET',
      url: `/api/notifications?userId=${userId}&limit=2`,
    });
    const one = pageOne.json();
    expect(one.notifications.map((row: { id: string }) => row.id)).toEqual([third.id, second.id]);
    expect(one.pagination.nextCursor).not.toBeNull();

    const pageTwo = await app.inject({
      method: 'GET',
      url: `/api/notifications?userId=${userId}&limit=2&cursor=${encodeURIComponent(one.pagination.nextCursor)}`,
    });
    const two = pageTwo.json();
    expect(two.notifications.map((row: { id: string }) => row.id)).toEqual([first.id]);
    expect(two.pagination.nextCursor).toBeNull();
  });

  it('breaks a tie on identical timestamps deterministically instead of repeating a row', async () => {
    // Two rows written in the same millisecond is ordinary: a scoring pass writes one page fast.
    const a = await reserve({ createdAt: BASE });
    const b = await reserve({ createdAt: BASE });

    const pageOne = await app.inject({
      method: 'GET',
      url: `/api/notifications?userId=${userId}&limit=1`,
    });
    const one = pageOne.json();
    expect(one.notifications).toHaveLength(1);
    expect(one.pagination.nextCursor).not.toBeNull();

    const pageTwo = await app.inject({
      method: 'GET',
      url: `/api/notifications?userId=${userId}&limit=1&cursor=${encodeURIComponent(one.pagination.nextCursor)}`,
    });
    const two = pageTwo.json();
    const seen = [one.notifications[0].id, ...two.notifications.map((row: { id: string }) => row.id)];

    expect(new Set(seen).size).toBe(2);
    expect(seen.sort()).toEqual([a.id, b.id].sort());
  });

  it('does not leak another candidate’s notifications', async () => {
    const mine = await reserve();
    await reserve({ user: otherUserId, event: 'NEW_MATCH-THEIRS' });

    const response = await app.inject({ method: 'GET', url: `/api/notifications?userId=${userId}` });

    const body = response.json();
    expect(body.notifications.map((row: { id: string }) => row.id)).toEqual([mine.id]);
  });

  it('filters by status', async () => {
    await reserve({ event: 'PENDING-ONE' });
    const failed = await reserve({ event: 'FAILED-ONE', status: 'FAILED', attemptCount: 5 });

    const response = await app.inject({
      method: 'GET',
      url: `/api/notifications?userId=${userId}&status=FAILED`,
    });

    const body = response.json();
    expect(body.notifications.map((row: { id: string }) => row.id)).toEqual([failed.id]);
  });

  it('rejects a cursor that is not a cursor', async () => {
    const badCursor = await app.inject({
      method: 'GET',
      url: `/api/notifications?cursor=not-a-cursor`,
    });

    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('ignores an unknown query parameter rather than failing the read', async () => {
    // Fastify's Ajv removes properties the schema forbids instead of refusing the request, the
    // same as the source and match routes; this pins that the notification route does not differ.
    const { id } = await reserve();

    const response = await app.inject({
      method: 'GET',
      url: `/api/notifications?userId=${userId}&includeDeleted=true`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().notifications.map((row: { id: string }) => row.id)).toEqual([id]);
  });

  it('answers an empty outbox with an empty page, not an error', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/notifications?userId=${userId}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ notifications: [], pagination: { nextCursor: null } });
  });
});

describe('POST /api/notifications/:id/feedback', () => {
  it('records the verdict and returns it with the notification', async () => {
    const { id } = await reserve();

    const response = await app.inject({
      method: 'POST',
      url: `/api/notifications/${id}/feedback`,
      payload: { value: 'RELEVANT' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id, feedback: 'RELEVANT' });
    expect(await prisma.notificationFeedback.count({ where: { notificationId: id } })).toBe(1);
  });

  it('replaces the previous verdict rather than accumulating contradicting rows', async () => {
    const { id } = await reserve();
    const post = (value: string) =>
      app.inject({ method: 'POST', url: `/api/notifications/${id}/feedback`, payload: { value } });

    await post('RELEVANT');
    const changed = await post('NOT_RELEVANT');

    expect(changed.json().feedback).toBe('NOT_RELEVANT');
    expect(await prisma.notificationFeedback.count({ where: { notificationId: id } })).toBe(1);
  });

  it('is visible in the list afterwards', async () => {
    const { id } = await reserve();
    await app.inject({
      method: 'POST',
      url: `/api/notifications/${id}/feedback`,
      payload: { value: 'UNSURE' },
    });

    const response = await app.inject({ method: 'GET', url: `/api/notifications?userId=${userId}` });

    expect(response.json().notifications[0]).toMatchObject({ id, feedback: 'UNSURE' });
  });

  it('answers 404 for a notification that does not exist, rather than creating a verdict for it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/notifications/00000000-0000-0000-0000-000000000000/feedback`,
      payload: { value: 'RELEVANT' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(await prisma.notificationFeedback.count()).toBe(0);
  });

  it('rejects a verdict the SRS does not define, and a missing one', async () => {
    const { id } = await reserve();

    const invented = await app.inject({
      method: 'POST',
      url: `/api/notifications/${id}/feedback`,
      payload: { value: 'MAYBE' },
    });
    expect(invented.statusCode).toBe(400);
    expect(invented.json().error.code).toBe('VALIDATION_ERROR');

    const missing = await app.inject({
      method: 'POST',
      url: `/api/notifications/${id}/feedback`,
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(await prisma.notificationFeedback.count()).toBe(0);
  });

  it('closes the loop: the verdict is what SRS 3.2 reads to suppress the job', async () => {
    const { id } = await reserve();

    await app.inject({
      method: 'POST',
      url: `/api/notifications/${id}/feedback`,
      payload: { value: 'NOT_RELEVANT' },
    });

    const resolved = await facts.factsForJobs({
      userId,
      jobIds: [jobId],
      notificationType: 'NEW_MATCH',
      event: 'NEW_MATCH',
    });
    expect(resolved.rejected.has(jobId)).toBe(true);
  });
});
