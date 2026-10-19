import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DescriptionQuality, LifecycleStatus } from '@domain/enums';
import { PrismaNotificationFactsReader } from '@infrastructure/matching/prisma-notification-facts-reader';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * The two SRS 3.2 predicates that are not facts about the job: "not already notified for
 * equivalent event" and "not suppressed/rejected" (FR-016, ENG-027, AC-016).
 *
 * Pinned here: the scoping. A fact about a *different* user, a different event, or a RELEVANT
 * verdict must not leak into the answer, because either leak notifies someone twice or silences
 * a job the user never rejected.
 */

const prisma = createTestPrismaClient();
const facts = new PrismaNotificationFactsReader(prisma);

let userId: string;
let otherUserId: string;
let jobId: string;
let otherJobId: string;

beforeAll(() => {
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);

  const user = await prisma.user.create({ data: { email: `facts-${Date.now()}@example.test` } });
  userId = user.id;
  const other = await prisma.user.create({ data: { email: `facts-other-${Date.now()}@example.test` } });
  otherUserId = other.id;

  const source = await prisma.jobSource.create({
    data: { name: `src-${Date.now()}`, adapterType: 'FAKE', adapterVersion: '1.0.0' },
  });
  const job = await prisma.job.create({
    data: { sourceId: source.id, identityKey: 'k1', descriptionQuality: DescriptionQuality.SUFFICIENT },
    select: { id: true },
  });
  jobId = job.id;
  const otherJob = await prisma.job.create({
    data: { sourceId: source.id, identityKey: 'k2', descriptionQuality: DescriptionQuality.SUFFICIENT },
    select: { id: true },
  });
  otherJobId = otherJob.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function ask(overrides: Partial<{ jobIds: string[]; user: string; event: string }> = {}) {
  return facts.factsForJobs({
    userId: overrides.user ?? userId,
    jobIds: overrides.jobIds ?? [jobId, otherJobId],
    notificationType: 'NEW_MATCH',
    event: overrides.event ?? 'NEW_MATCH',
  });
}

async function reserve(targetUserId: string, targetJobId: string, event = 'NEW_MATCH') {
  await prisma.notificationOutbox.create({
    data: {
      userId: targetUserId,
      jobId: targetJobId,
      notificationType: 'NEW_MATCH',
      event,
      payload: {},
    },
  });
}

describe('notification facts for a page of jobs', () => {
  it('reports nothing when there is no history', async () => {
    const result = await ask();

    expect([...result.alreadyNotified]).toEqual([]);
    expect([...result.rejected]).toEqual([]);
  });

  it('reports the job whose event is already reserved', async () => {
    await reserve(userId, jobId);

    const result = await ask();

    expect([...result.alreadyNotified]).toEqual([jobId]);
  });

  it('ignores a reservation of a different event, and another user of the same job', async () => {
    await reserve(userId, jobId, 'SALARY_DISCLOSED');
    await reserve(otherUserId, jobId);

    const result = await ask();

    expect([...result.alreadyNotified]).toEqual([]);
  });

  it('reports a job the user rejected (NOT_RELEVANT)', async () => {
    await reserve(userId, jobId);
    const notification = await prisma.notificationOutbox.findFirstOrThrow({ where: { userId, jobId } });
    await prisma.notificationFeedback.create({
      data: { notificationId: notification.id, value: 'NOT_RELEVANT' },
    });

    const result = await ask();

    expect([...result.rejected]).toEqual([jobId]);
  });

  it('does not treat another verdict, or another user, as a rejection', async () => {
    await reserve(userId, jobId);
    const mine = await prisma.notificationOutbox.findFirstOrThrow({ where: { userId, jobId } });
    await prisma.notificationFeedback.create({
      data: { notificationId: mine.id, value: 'UNSURE' },
    });
    await reserve(otherUserId, otherJobId);
    const theirs = await prisma.notificationOutbox.findFirstOrThrow({
      where: { userId: otherUserId, jobId: otherJobId },
    });
    await prisma.notificationFeedback.create({
      data: { notificationId: theirs.id, value: 'NOT_RELEVANT' },
    });

    const result = await ask();

    expect([...result.rejected]).toEqual([]);
  });

  it('answers an empty page without asking the database anything', async () => {
    const result = await facts.factsForJobs({
      userId,
      jobIds: [],
      notificationType: 'NEW_MATCH',
      event: 'NEW_MATCH',
    });

    expect([...result.alreadyNotified]).toEqual([]);
    expect([...result.rejected]).toEqual([]);
  });

  it('takes one pass over a page, not one query per job', async () => {
    await reserve(userId, jobId);
    await reserve(userId, otherJobId);

    const result = await ask({ jobIds: [jobId, otherJobId] });

    expect([...result.alreadyNotified].sort()).toEqual([jobId, otherJobId].sort());
    // A job the caller did not ask about is not in the answer, whatever the database holds.
    expect(result.alreadyNotified.has('00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});

describe('the lifecycle of a rejected job', () => {
  it('keeps reporting the rejection once the job has expired', async () => {
    await reserve(userId, jobId);
    const notification = await prisma.notificationOutbox.findFirstOrThrow({ where: { userId, jobId } });
    await prisma.notificationFeedback.create({
      data: { notificationId: notification.id, value: 'NOT_RELEVANT' },
    });
    await prisma.job.update({
      where: { id: jobId },
      data: { lifecycleStatus: LifecycleStatus.EXPIRED },
    });

    const result = await ask();

    expect(result.rejected.has(jobId)).toBe(true);
  });
});
