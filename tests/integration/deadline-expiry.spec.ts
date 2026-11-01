import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationMethod, LifecycleStatus, NotificationStatus } from '@domain/enums';
import { DEADLINE_GRACE_MS, isPastDeadline } from '@domain/lifecycle/deadline-policy';
import { hasUsableApplicationPath } from '@domain/normalizers/application-target';
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
 *  - the dispatcher's SQL guard answers the same question as `isPastDeadline`, and the same
 *    question as `hasUsableApplicationPath`, because both predicates are repeated in SQL for a
 *    single-statement claim, and a drift would silently notify candidates about postings they can
 *    no longer act on;
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
  overrides: Partial<{
    deadline: Date | null;
    status: LifecycleStatus;
    method: ApplicationMethod;
    applyUrl: string | null;
    applyEmail: string | null;
  }> = {},
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
      // The reservation path cannot create a row for a job with no usable path (AC-004), so the
      // fixtures carry one by default. A test that asks the path question passes the method and
      // both targets explicitly, including `null` for the one its rule requires to be missing —
      // which is why `applyEmail` is read with `in` rather than with a coalesce.
      applicationMethod: overrides.method ?? ApplicationMethod.EMAIL,
      applyUrl: overrides.applyUrl ?? null,
      applyEmail: 'applyEmail' in overrides ? (overrides.applyEmail ?? null) : 'jobs@example.test',
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

  it('does not overwrite a status the presence sweep moved after this pass read it', async () => {
    // Audit M1, seen from the other policy: the two passes write the same column, so each fences
    // on what it read. `REMOVED` is the source's verdict about whether the posting still exists
    // and this pass can never re-derive it, so a read that raced with a sweep must not clobber it.
    const jobId = await jobWith({ deadline: PAST });
    const candidates = await jobs.listDeadlineCandidates();
    expect(candidates).toHaveLength(1);

    await prisma.job.update({
      where: { id: jobId },
      data: { lifecycleStatus: LifecycleStatus.REMOVED },
    });

    const applied = await jobs.applyLifecycleStatuses(
      candidates.map((candidate) => ({
        jobId: candidate.jobId,
        expectedStatus: candidate.currentStatus,
        status: LifecycleStatus.EXPIRED,
      })),
    );

    expect(applied).toBe(0);
    expect(await statusOf(jobId)).toBe(LifecycleStatus.REMOVED);
  });
});

describe('the dispatch guard agrees with the domain eligibility rules', () => {
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

  it('cancels a reservation exactly when hasUsableApplicationPath says the path is unusable (AC-004)', async () => {
    // The application target can drift after a reservation: a recapture that loses the link, or a
    // source that republishes the posting with the address removed. Each row of `ApplicationMethod`
    // appears with and without the target its own rule requires, so the SQL cannot silently
    // disagree with the domain about any of them.
    const targets = [
      { method: ApplicationMethod.ONLINE_URL, applyUrl: 'https://example.test/apply', applyEmail: null },
      { method: ApplicationMethod.ONLINE_URL, applyUrl: null, applyEmail: null },
      { method: ApplicationMethod.PDF_FORM, applyUrl: 'https://example.test/form.pdf', applyEmail: null },
      { method: ApplicationMethod.PDF_FORM, applyUrl: null, applyEmail: null },
      { method: ApplicationMethod.EMAIL, applyUrl: null, applyEmail: 'jobs@example.test' },
      { method: ApplicationMethod.EMAIL, applyUrl: null, applyEmail: null },
      { method: ApplicationMethod.SOURCE_ACCOUNT, applyUrl: null, applyEmail: null },
      { method: ApplicationMethod.IN_PERSON, applyUrl: null, applyEmail: null },
      { method: ApplicationMethod.INSTRUCTIONS, applyUrl: null, applyEmail: null },
      { method: ApplicationMethod.UNKNOWN, applyUrl: null, applyEmail: null },
    ];
    const user = await prisma.user.create({ data: { email: `path-${counter}@example.test` } });
    const expected: { jobId: string; usable: boolean }[] = [];

    for (const target of targets) {
      const jobId = await jobWith(target);
      await prisma.notificationOutbox.create({
        data: {
          userId: user.id,
          jobId,
          notificationType: 'NEW_MATCH',
          event: 'NEW_MATCH',
          payload: {},
          nextAttemptAt: NOW,
        },
      });
      expected.push({
        jobId,
        usable: hasUsableApplicationPath({ ...target, evidence: null }),
      });
    }

    const cancelled = await outbox.cancelIneligible({ now: NOW });

    expect(cancelled).toBe(expected.filter((entry) => !entry.usable).length);
    for (const entry of expected) {
      expect(await outboxStatusOf(entry.jobId)).toBe(
        entry.usable ? NotificationStatus.PENDING : NotificationStatus.CANCELLED,
      );
    }
  });

  it('cancels a reservation the user already marked not relevant (FR-018)', async () => {
    const rejected = await jobWith();
    const untouched = await jobWith();
    const user = await prisma.user.create({ data: { email: `verdict-${counter}@example.test` } });
    const rejectedRow = await prisma.notificationOutbox.create({
      data: {
        userId: user.id,
        jobId: rejected,
        notificationType: 'NEW_MATCH',
        event: 'NEW_MATCH',
        payload: {},
        nextAttemptAt: NOW,
      },
      select: { id: true },
    });
    await prisma.notificationOutbox.create({
      data: {
        userId: user.id,
        jobId: untouched,
        notificationType: 'NEW_MATCH',
        event: 'NEW_MATCH',
        payload: {},
        nextAttemptAt: NOW,
      },
    });
    await prisma.notificationFeedback.create({
      data: { notificationId: rejectedRow.id, value: 'NOT_RELEVANT' },
    });

    expect(await outbox.cancelIneligible({ now: NOW })).toBe(1);
    expect(await outboxStatusOf(rejected)).toBe(NotificationStatus.CANCELLED);
    expect(await outboxStatusOf(untouched)).toBe(NotificationStatus.PENDING);
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
