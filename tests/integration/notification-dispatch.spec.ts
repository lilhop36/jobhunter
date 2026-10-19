import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationMethod, DescriptionQuality, SalaryPeriod, SalaryType } from '@domain/enums';
import { DispatchNotifications } from '@application/notification';
import { PrismaNotificationOutboxRepository } from '@infrastructure/matching/prisma-notification-outbox-repository';
import type { NotificationSender, SendOutcome } from '@ports/notification-sender';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * Delivery against the real database, with a fake channel (SRS 3.2 "Rate limits", FR-017,
 * AC-015).
 *
 * The channel is a port, so what is pinned here is the dispatcher's contract with the *outbox*:
 * a due row is claimed exactly once and sent once; a retryable failure is rescheduled with a
 * growing wait and its attempt counted; a permanent failure or an exhausted ladder becomes
 * terminal; and a row is never left in `PROCESSING` where nothing would look at it again.
 */

const prisma = createTestPrismaClient();
const outbox = new PrismaNotificationOutboxRepository(prisma);

const NOW = new Date('2026-10-19T12:00:00.000Z');
const PAYLOAD = {
  eligibilityVersion: '1.0.0',
  eligibilityExplanation: 'eligible: all SRS 3.2 predicates hold',
  matcherVersion: '1.0.0',
  score: 90,
  confidence: 54,
  explanation: 'Role and location match.',
  matchedSkills: [],
  missingSkills: [],
  uncertainSkills: [],
};

interface RecordingSender extends NotificationSender {
  readonly seen: string[];
}

function senderReturning(outcome: SendOutcome | (() => SendOutcome)): RecordingSender {
  const seen: string[] = [];
  return {
    seen,
    send: async (message) => {
      seen.push(message.text);
      return typeof outcome === 'function' ? outcome() : outcome;
    },
  };
}

let userId: string;
let jobId: string;
let counter = 0;

beforeAll(() => {
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);

  counter += 1;
  const user = await prisma.user.create({ data: { email: `dispatch-${counter}@example.test` } });
  userId = user.id;

  const source = await prisma.jobSource.create({
    data: { name: `src-${counter}`, adapterType: 'FAKE', adapterVersion: '1.0.0' },
  });
  const job = await prisma.job.create({
    data: {
      sourceId: source.id,
      identityKey: 'k1',
      title: 'Backend Engineer',
      company: 'Acme',
      locationText: 'Addis Ababa',
      descriptionQuality: DescriptionQuality.SUFFICIENT,
      salaryType: SalaryType.RANGE,
      salaryMin: '60000.00',
      salaryMax: '90000.00',
      salaryCurrency: 'ETB',
      salaryPeriod: SalaryPeriod.MONTH,
      applicationMethod: ApplicationMethod.EMAIL,
      applyEmail: 'jobs@example.test',
    },
    select: { id: true },
  });
  jobId = job.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function reserve(
  overrides: Partial<{ nextAttemptAt: Date; attemptCount: number; event: string }> = {},
) {
  return prisma.notificationOutbox.create({
    data: {
      userId,
      jobId,
      notificationType: 'NEW_MATCH',
      event: overrides.event ?? 'NEW_MATCH',
      payload: PAYLOAD,
      nextAttemptAt: overrides.nextAttemptAt ?? NOW,
      attemptCount: overrides.attemptCount ?? 0,
    },
    select: { id: true },
  });
}

function dispatcherWith(sender: NotificationSender): DispatchNotifications {
  return new DispatchNotifications({ outbox, sender });
}

async function row(id: string) {
  return prisma.notificationOutbox.findFirstOrThrow({ where: { id } });
}

describe('DispatchNotifications', () => {
  it('sends a due row and records the delivery', async () => {
    const { id } = await reserve();
    const sender = senderReturning({ delivered: true });

    const result = await dispatcherWith(sender).run({ now: NOW });

    expect(result).toEqual({ attempted: 1, sent: 1, retried: 0, failed: 0 });
    const stored = await row(id);
    expect(stored.status).toBe('SENT');
    expect(stored.sentAt?.toISOString()).toBe(NOW.toISOString());
    expect(stored.attemptCount).toBe(1);
  });

  it('sends the SRS 3.2 content rendered from the stored rows', async () => {
    await reserve();
    const sender = senderReturning({ delivered: true });

    await dispatcherWith(sender).run({ now: NOW });

    expect(sender.seen).toHaveLength(1);
    expect(sender.seen[0]).toContain('Job: Backend Engineer');
    expect(sender.seen[0]).toContain('Company: Acme');
    expect(sender.seen[0]).toContain('Match: 90/100 relevance, 54% confidence');
    expect(sender.seen[0]).toContain('Apply: jobs@example.test');
  });

  it('never sends a delivered row again', async () => {
    await reserve();
    const sender = senderReturning({ delivered: true });
    const dispatcher = dispatcherWith(sender);

    await dispatcher.run({ now: NOW });
    const second = await dispatcher.run({ now: new Date(NOW.getTime() + 86_400_000) });

    expect(second.attempted).toBe(0);
    expect(sender.seen).toHaveLength(1);
  });

  it('leaves a row whose backoff has not elapsed alone', async () => {
    await reserve({ nextAttemptAt: new Date(NOW.getTime() + 60_000) });
    const sender = senderReturning({ delivered: true });

    const result = await dispatcherWith(sender).run({ now: NOW });

    expect(result.attempted).toBe(0);
    expect(sender.seen).toEqual([]);
  });

  it('reschedules a retryable failure with the policy wait and the attempt counted', async () => {
    const { id } = await reserve();
    const sender = senderReturning({
      delivered: false,
      retryable: true,
      reason: 'Telegram API returned 500',
    });

    const result = await dispatcherWith(sender).run({ now: NOW });

    expect(result).toEqual({ attempted: 1, sent: 0, retried: 1, failed: 0 });
    const stored = await row(id);
    expect(stored.status).toBe('PENDING');
    expect(stored.attemptCount).toBe(1);
    expect(stored.lastError).toBe('Telegram API returned 500');
    expect(stored.nextAttemptAt.toISOString()).toBe(new Date(NOW.getTime() + 60_000).toISOString());
  });

  it('honours a 429 retry-after hint over the ladder', async () => {
    const { id } = await reserve({ attemptCount: 1 });
    const sender = senderReturning({
      delivered: false,
      retryable: true,
      reason: 'Telegram API returned 429',
      retryAfterSeconds: 900,
    });

    await dispatcherWith(sender).run({ now: NOW });

    const stored = await row(id);
    expect(stored.nextAttemptAt.toISOString()).toBe(new Date(NOW.getTime() + 900_000).toISOString());
  });

  it('fails terminally when the channel says the failure is permanent', async () => {
    const { id } = await reserve();
    const sender = senderReturning({
      delivered: false,
      retryable: false,
      reason: 'chat not found',
    });

    const result = await dispatcherWith(sender).run({ now: NOW });

    expect(result).toEqual({ attempted: 1, sent: 0, retried: 0, failed: 1 });
    const stored = await row(id);
    expect(stored.status).toBe('FAILED');
    expect(stored.lastError).toBe('chat not found');
  });

  it('fails terminally once the attempt ladder is exhausted', async () => {
    const { id } = await reserve({ attemptCount: 4 });
    const sender = senderReturning({ delivered: false, retryable: true, reason: 'still down' });

    const result = await dispatcherWith(sender).run({ now: NOW });

    expect(result).toEqual({ attempted: 1, sent: 0, retried: 0, failed: 1 });
    // The claim counted the fifth attempt, which is the last one the policy allows.
    expect((await row(id)).status).toBe('FAILED');
  });

  it('treats a throwing channel as a transient failure, not as a lost row', async () => {
    const { id } = await reserve();
    const exploding: NotificationSender = {
      send: async () => {
        throw new Error('socket hang up');
      },
    };

    const result = await dispatcherWith(exploding).run({ now: NOW });

    expect(result).toEqual({ attempted: 1, sent: 0, retried: 1, failed: 0 });
    const stored = await row(id);
    expect(stored.status).toBe('PENDING');
    expect(stored.lastError).toBe('socket hang up');
  });

  it('delivers a row that was left in PROCESSING by a dead dispatcher', async () => {
    const { id } = await reserve();
    // Exactly what a crash between claim and record leaves behind.
    await prisma.notificationOutbox.update({
      where: { id },
      data: { status: 'PROCESSING', attemptCount: 1 },
    });
    const dispatcher = dispatcherWith(senderReturning({ delivered: true }));

    const stranded = await dispatcher.run({ now: NOW });
    expect(stranded.attempted).toBe(0);

    expect(await dispatcher.recoverAbandoned()).toBe(1);
    const recovered = await dispatcher.run({ now: NOW });

    expect(recovered.sent).toBe(1);
    expect((await row(id)).status).toBe('SENT');
  });

  it('does not claim a row another dispatcher already holds', async () => {
    const { id } = await reserve();
    await dispatcherWith(senderReturning({ delivered: true })).run({ now: NOW });
    // Re-open it as if the recording had failed mid-flight, then leave it PROCESSING.
    await prisma.notificationOutbox.update({
      where: { id },
      data: { status: 'PROCESSING' },
    });
    const sender = senderReturning({ delivered: true });

    const result = await dispatcherWith(sender).run({ now: NOW });

    expect(result.attempted).toBe(0);
    expect(sender.seen).toEqual([]);
  });

  it('claims a bounded batch, oldest due first', async () => {
    // Distinct events, because one (user, job, type, event) is one row ever (AC-016).
    await reserve({ event: 'OLDEST', nextAttemptAt: new Date(NOW.getTime() - 120_000) });
    const second = await reserve({ event: 'MIDDLE', nextAttemptAt: new Date(NOW.getTime() - 60_000) });
    await reserve({ event: 'NEWEST', nextAttemptAt: NOW });
    const sender = senderReturning({ delivered: true });

    const result = await dispatcherWith(sender).run({ now: NOW, limit: 2 });

    expect(result).toEqual({ attempted: 2, sent: 2, retried: 0, failed: 0 });
    expect(await prisma.notificationOutbox.count({ where: { status: 'PENDING' } })).toBe(1);
    expect((await row(second.id)).status).toBe('SENT');
  });
});
