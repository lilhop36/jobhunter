import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LifecycleStatus, NotificationStatus } from '@domain/enums';
import { DEADLINE_GRACE_MS, isPastDeadline } from '@domain/lifecycle/deadline-policy';
import { ExpireDeadlines } from '@application/lifecycle';
import { DispatchNotifications } from '@application/notification';
import { PrismaJobRepository } from '@infrastructure/ingestion/prisma-job-repository';
import { PrismaNotificationOutboxRepository } from '@infrastructure/matching/prisma-notification-outbox-repository';
import type { NotificationSender } from '@ports/notification-sender';
import { silentWorkerLogger } from '@ports/worker-logger';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * Deadline expiry against the real database (FR-019, FR-016).
 *
 * What is pinned here:
 *  - the reconciliation moves exactly ACTIVE -> EXPIRED and never another policy's states;
 *  - the dispatcher's SQL guard answers the same question as `isPastDeadline`, because that
 *    predicate is repeated in SQL for a single-statement claim, and a drift would silently
 *    notify candidates about postings they can no longer act on;
 *  - a reservation made before a deadline passed is cancelled, not sent (SRS 3.2: ACTIVE).
 */

const prisma = createTestPrismaClient();
const jobs = new PrismaJobRepository(prisma);
const outbox = new PrismaNotificationOutboxRepository(prisma);
const expire = new ExpireDeadlines({ jobs, logger: silentWorkerLogger });

const NOW = new Date('2026-11-01T00:00:00.000Z');
const PAST = new Date('2026-10-30T00:00:00.000Z');
const FUTURE = new Date('2027-01-01T00:00:00.000Z');

let counter = 0;
let sourceId: string;
let createdJobs = 0;

beforeAll(() => {
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);
  counter += 1;
  createdJobs = 0;
  sourceId = (
    await prisma.jobSource.create({
      data: { name: `deadline-src-${counter}`, adapterType: 'FAKE', adapterVersion: '1.0.0' },
    })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function jobWith(
  overrides: Partial<{ deadline: Date | null; status: LifecycleStatus }> = {},
): Promise<string> {
  createdJobs += 1;
  const job = await prisma.job.create({
    data: {
      sourceId,
      identityKey: `k-${counter}-${createdJobs}`,
      title: 'Backend Engineer',
      descriptionQuality: 'SUFFICIENT',
      lifecycleStatus: overrides.status ?? LifecycleStatus.ACTIVE,
      applicationDeadline: overrides.deadline ?? null,
    },
    select: { id: true },
  });
  return job.id;
}

function senderRecording(seen: string[]): NotificationSender {
  return {
    send: async (message) => {
      seen.push(message.text);
      return { delivered: true };
    },
  };
}

async function statusOf(jobId: string): Promise<LifecycleStatus | undefined> {
  const row = await prisma.job.findUnique({
    where: { id: jobId },
    select: { lifecycleStatus: true },
  });
  return row?.lifecycleStatus as LifecycleStatus | undefined;
}

async function outboxStatusOf(jobId: string): Promise<NotificationStatus | undefined> {
  const row = await prisma.notificationOutbox.findFirstOrThrow({
    where: { jobId },
    select: { status: true },
  });
  return row.status as NotificationStatus;
}

describe('ExpireDeadlines', () => {
  it('expires an ACTIVE job whose stated deadline has passed', async () => {
    const jobId = await jobWith({ deadline: new Date('2026-10-30T00:00:00.000Z') });

    const result = await expire.run({ now: NOW });

    expect(result).toEqual({ examined: 1, expired: 1, restored: 0 });
    expect(await statusOf(jobId)).toBe(LifecycleStatus.EXPIRED);
  });

  it('leaves an ACTIVE job with a live deadline alone', async () => {
    const jobId = await jobWith({ deadline: FUTURE });

    const result = await expire.run({ now: NOW });

    expect(result).toEqual({ examined: 1, expired: 0, restored: 0 });
    expect(await statusOf(jobId)).toBe(LifecycleStatus.ACTIVE);
  });

  it('leaves a job with no deadline alone (UNKNOWN is not expiry evidence)', async () => {
    await jobWith({ deadline: null });

    const result = await expire.run({ now: NOW });

    expect(result).toEqual({ examined: 0, expired: 0, restored: 0 });
  });

  it('never moves REMOVED or NOT_FOUND, even with a long-past deadline', async () => {
    const removed = await jobWith({ deadline: new Date('2020-01-01T00:00:00.000Z'), status: LifecycleStatus.REMOVED });
    const notFound = await jobWith({ deadline: new Date('2020-01-01T00:00:00.000Z'), status: LifecycleStatus.NOT_FOUND });

    const result = await expire.run({ now: NOW });

    expect(result.expired).toBe(0);
    expect(await statusOf(removed)).toBe(LifecycleStatus.REMOVED);
    expect(await statusOf(notFound)).toBe(LifecycleStatus.NOT_FOUND);
  });

  it('restores an EXPIRED job whose deadline moved forward, and one whose deadline is gone', async () => {
    const movedForward = await jobWith({ status: LifecycleStatus.EXPIRED, deadline: FUTURE });
    const evidenceGone = await jobWith({ status: LifecycleStatus.EXPIRED, deadline: null });

    const result = await expire.run({ now: NOW });

    expect(result.restored).toBe(2);
    expect(await statusOf(movedForward)).toBe(LifecycleStatus.ACTIVE);
    expect(await statusOf(evidenceGone)).toBe(LifecycleStatus.ACTIVE);
  });
});

describe('the dispatch guard agrees with the domain deadline rule', () => {
  it('cancels a reservation exactly when isPastDeadline says the deadline passed', async () => {
    const deadline = new Date('2026-10-30T00:00:00.000Z');
    const jobId = await jobWith({ deadline });
    const user = await prisma.user.create({ data: { email: `guard-${counter}@example.test` } });
    await prisma.notificationOutbox.create({
      data: {
        userId: user.id,
        jobId,
        notificationType: 'NEW_MATCH',
        event: 'NEW_MATCH',
        payload: {},
        nextAttemptAt: NOW,
      },
      select: { id: true },
    });
    expect(await outboxStatusOf(jobId)).toBe(NotificationStatus.PENDING);

    // One millisecond inside the grace the row must survive; at the boundary it must not.
    await outbox.cancelIneligible({ now: new Date(deadline.getTime() + DEADLINE_GRACE_MS - 1) });
    expect(await outboxStatusOf(jobId)).toBe(NotificationStatus.PENDING);

    await outbox.cancelIneligible({ now: new Date(deadline.getTime() + DEADLINE_GRACE_MS) });
    expect(await outboxStatusOf(jobId)).toBe(NotificationStatus.CANCELLED);
  });
});

describe('DispatchNotifications honours the deadline guard (FR-016)', () => {
  it('cancels a reserved row whose job expired after the reservation, and sends the live one', async () => {
    const expiredJob = await jobWith({ deadline: PAST });
    const liveJob = await jobWith({ deadline: FUTURE });

    const user = await prisma.user.create({ data: { email: `expiry-${counter}@example.test` } });
    await prisma.notificationOutbox.create({
      data: {
        userId: user.id,
        jobId: expiredJob,
        notificationType: 'NEW_MATCH',
        event: 'NEW_MATCH',
        payload: { explanation: 'was eligible when it was reserved' },
        nextAttemptAt: NOW,
      },
      select: { id: true },
    });
    await prisma.notificationOutbox.create({
      data: {
        userId: user.id,
        jobId: liveJob,
        notificationType: 'NEW_MATCH',
        event: 'NEW_MATCH',
        payload: { explanation: 'still open' },
        nextAttemptAt: NOW,
      },
      select: { id: true },
    });

    const seen: string[] = [];
    const result = await new DispatchNotifications({
      outbox,
      sender: senderRecording(seen),
    }).run({ now: NOW });

    expect(await outboxStatusOf(expiredJob)).toBe(NotificationStatus.CANCELLED);
    expect(await outboxStatusOf(liveJob)).toBe(NotificationStatus.SENT);
    expect(seen).toHaveLength(1);
    expect(result).toEqual({ attempted: 1, sent: 1, retried: 0, failed: 0 });
  });
});
