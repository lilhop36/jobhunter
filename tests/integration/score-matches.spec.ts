import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  ApplicationMethod,
  CalendarType,
  DescriptionQuality,
  EmploymentType,
  LifecycleStatus,
  LocationCategory,
  RemoteStatus,
  RelocationPreference,
  RemotePreference,
  SalaryPeriod,
  SalaryType,
  SkillEvidence,
} from '@domain/enums';
import { MATCHER_VERSION } from '@domain/matching';
import { NOTIFICATION_ELIGIBILITY_VERSION } from '@domain/notification';
import {
  asDecimalAmount,
  asProbability,
  type MatchableJob,
} from '@domain/types';
import type { UnversionedCandidateProfile } from '@domain/matching';
import { ScoreMatches } from '@application/matching';
import { PrismaCandidateProfileRepository } from '@infrastructure/ingestion/prisma-candidate-profile-repository';
import { PrismaJobMatchRepository } from '@infrastructure/ingestion/prisma-job-match-repository';
import { PrismaMatchableJobReader } from '@infrastructure/matching/prisma-matchable-job-reader';
import { PrismaNotificationFactsReader } from '@infrastructure/matching/prisma-notification-facts-reader';
import type { MatchableJobReader } from '@ports/matchable-job-reader';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * The scoring use case against the real database and the real adapters (FR-013, FR-014; SRS 11.2).
 *
 * What is being pinned is the *contract*, not the arithmetic (the matcher's own unit tests cover
 * that): one row per (user, job, input set); a rerun writes nothing; a profile edit adds a row
 * instead of erasing the previous score; the clock moves the output but never the identity; and
 * a job the policy rejects produces no match at all.
 */

const prisma = createTestPrismaClient();
const profiles = new PrismaCandidateProfileRepository(prisma);
const reader = new PrismaMatchableJobReader(prisma);
const matchRepository = new PrismaJobMatchRepository(prisma);
const scoring = new ScoreMatches({
  profiles,
  jobs: reader,
  matches: matchRepository,
  facts: new PrismaNotificationFactsReader(prisma),
});

const FIRST_NOW = new Date('2026-10-05T00:00:00.000Z');

let counter = 0;
let userId: string;
let sourceId: string;
let jobIds: string[];

beforeAll(() => {
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);

  const user = await prisma.user.create({
    data: { email: `scoring-${Date.now()}-${counter++}@example.test` },
    select: { id: true },
  });
  userId = user.id;

  const source = await prisma.jobSource.create({
    data: { name: `src-${Date.now()}-${counter++}`, adapterType: 'FAKE', adapterVersion: '1.0.0' },
    select: { id: true },
  });
  sourceId = source.id;

  jobIds = [
    await createJob(),
    await createJob({ title: 'Senior Backend Engineer' }),
    await createJob({ title: 'Data Analyst', locationCategory: LocationCategory.ETHIOPIA_CITY, locationText: 'Jimma' }),
  ];
});

afterAll(async () => {
  await prisma.$disconnect();
});

function profile(overrides: Partial<UnversionedCandidateProfile> = {}): UnversionedCandidateProfile {
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
      { canonicalSkill: 'TypeScript', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) },
    ],
    targetRoles: [{ title: 'Backend Engineer', aliases: [] }],
    locationPreferences: [{ category: LocationCategory.ADDIS_ABABA, text: null }],
    ...overrides,
  };
}

async function createJob(overrides: Partial<Prisma.JobUncheckedCreateInput> = {}): Promise<string> {
  const row = await prisma.job.create({
    data: {
      sourceId,
      identityKey: `k-${counter++}`,
      descriptionQuality: DescriptionQuality.SUFFICIENT,
      title: 'Backend Engineer',
      publishedCalendar: CalendarType.GREGORIAN,
      publishedAt: new Date('2026-10-01T00:00:00.000Z'),
      dateConfidence: '0.950',
      locationText: 'Addis Ababa',
      locationCategory: LocationCategory.ADDIS_ABABA,
      remoteStatus: RemoteStatus.ONSITE,
      employmentType: EmploymentType.FULL_TIME,
      salaryType: SalaryType.RANGE,
      salaryMin: '60000.00',
      salaryMax: '90000.00',
      salaryCurrency: 'ETB',
      salaryPeriod: SalaryPeriod.MONTH,
      salaryConfidence: '0.900',
      ...overrides,
    },
    select: { id: true },
  });
  return row.id;
}

/** A scoring view for the policy test, which must not depend on what the reader happens to return. */
function matchableJob(): MatchableJob {
  return {
    title: 'Backend Engineer',
    descriptionQuality: DescriptionQuality.SUFFICIENT,
    locationText: 'Addis Ababa',
    locationCategory: LocationCategory.ADDIS_ABABA,
    remoteStatus: RemoteStatus.ONSITE,
    employmentType: EmploymentType.FULL_TIME,
    salary: {
      type: SalaryType.RANGE,
      min: asDecimalAmount('60000.00'),
      max: asDecimalAmount('90000.00'),
      currency: 'ETB',
      period: SalaryPeriod.MONTH,
      evidence: null,
      confidence: asProbability(0.9),
    },
    publishedDate: {
      calendar: CalendarType.GREGORIAN,
      publishedAt: new Date('2026-10-01T00:00:00.000Z'),
      originalText: null,
      confidence: asProbability(0.95),
      conversionMethod: null,
    },
    skills: [],
    requiredExperience: null,
  };
}

describe('ScoreMatches.run', () => {
  it('scores every matchable job and stores one row per job, across pages', async () => {
    await profiles.saveForUser({ userId, profile: profile() });

    const result = await scoring.run({ now: FIRST_NOW, pageSize: 2 });

    expect(result).toEqual({
      profiles: 1,
      jobScores: 3,
      skipped: 0,
      inserted: 3,
      updated: 0,
      unchanged: 0,
      // No fixture job has an application path, so none is notifiable (SRS 3.5).
      notificationsReserved: 0,
    });

    const rows = await prisma.jobMatch.findMany({ where: { userId } });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.jobId)).size).toBe(3);
    expect(rows.every((row) => row.matcherVersion === MATCHER_VERSION)).toBe(true);
    expect(rows.every((row) => row.profileVersion.length > 0)).toBe(true);
    expect(rows.every((row) => row.inputHash.startsWith('v1:'))).toBe(true);
    // The Skills factor has no producer yet, so it is stored as NULL (excluded), never as 0 (AC-010).
    expect(rows.every((row) => row.skillScore === null)).toBe(true);
    expect(rows.every((row) => row.roleScore !== null)).toBe(true);
  });

  it('does nothing at all when no profile exists', async () => {
    const result = await scoring.run({ now: FIRST_NOW });

    expect(result).toEqual({
      profiles: 0,
      jobScores: 0,
      skipped: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      notificationsReserved: 0,
    });
    expect(await prisma.jobMatch.count()).toBe(0);
  });

  it('writes nothing on a rerun with the same inputs', async () => {
    await profiles.saveForUser({ userId, profile: profile() });
    await scoring.run({ now: FIRST_NOW, pageSize: 2 });
    const before = await prisma.jobMatch.findMany({ where: { userId }, orderBy: { jobId: 'asc' } });

    const second = await scoring.run({ now: FIRST_NOW, pageSize: 2 });

    expect(second).toEqual({
      profiles: 1,
      jobScores: 3,
      skipped: 0,
      inserted: 0,
      updated: 0,
      unchanged: 3,
      notificationsReserved: 0,
    });
    const after = await prisma.jobMatch.findMany({ where: { userId }, orderBy: { jobId: 'asc' } });
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => row.scoredAt.getTime())).toEqual(before.map((row) => row.scoredAt.getTime()));
  });

  it('converges on one row per job when a run is repeated after a crash', async () => {
    await profiles.saveForUser({ userId, profile: profile() });

    await scoring.run({ now: FIRST_NOW, pageSize: 1 });
    await scoring.run({ now: FIRST_NOW, pageSize: 1 });

    expect(await prisma.jobMatch.count({ where: { userId } })).toBe(3);
  });

  it('keeps the previous score when the profile changes', async () => {
    const first = await profiles.saveForUser({ userId, profile: profile() });
    expect((await scoring.run({ now: FIRST_NOW, pageSize: 5 })).inserted).toBe(3);

    const second = await profiles.saveForUser({ userId, profile: profile({ experienceYears: 9 }) });
    expect(second.profileVersion).not.toBe(first.profileVersion);

    const afterEdit = await scoring.run({ now: FIRST_NOW, pageSize: 5 });

    expect(afterEdit).toEqual({
      profiles: 1,
      jobScores: 3,
      skipped: 0,
      inserted: 3,
      updated: 0,
      unchanged: 0,
      notificationsReserved: 0,
    });
    // Both revisions survive: a profile edit adds history rather than rewriting it.
    expect(await prisma.jobMatch.count({ where: { userId } })).toBe(6);
    expect(await prisma.jobMatch.count({ where: { userId, profileVersion: first.profileVersion } })).toBe(3);
  });

  it('updates the same row when only the clock moves', async () => {
    await profiles.saveForUser({ userId, profile: profile() });
    await scoring.run({ now: FIRST_NOW, pageSize: 5 });
    const before = await prisma.jobMatch.findMany({ where: { userId }, orderBy: { jobId: 'asc' } });

    // Two months later the postings are stale, so freshness and the total score fall — but the
    // inputs have not changed, so this is the same row, not a new one.
    const later = await scoring.run({ now: new Date('2026-12-15T00:00:00.000Z'), pageSize: 5 });

    expect(later).toEqual({
      profiles: 1,
      jobScores: 3,
      skipped: 0,
      inserted: 0,
      updated: 3,
      unchanged: 0,
      // None of the fixture jobs has an application path, so none is notifiable (SRS 3.5).
      notificationsReserved: 0,
    });
    const after = await prisma.jobMatch.findMany({ where: { userId }, orderBy: { jobId: 'asc' } });
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => row.freshnessScore)).toEqual([0, 0, 0]);
    expect(after.every((row, index) => row.score < before[index].score)).toBe(true);
    expect(after.every((row, index) => row.scoredAt.getTime() > before[index].scoredAt.getTime())).toBe(true);
  });

  it('skips a job the policy rejects instead of scoring it', async () => {
    await profiles.saveForUser({ userId, profile: profile() });
    let calls = 0;
    // A reader that hands over a job the policy must refuse: the re-check is the only thing
    // standing between an expired posting and a stored match.
    const staleReader: MatchableJobReader = {
      listMatchableJobs: async () =>
        calls++ === 0
          ? [
              {
                jobId: jobIds[0],
                sourceId,
                lifecycleStatus: LifecycleStatus.EXPIRED,
                applicationTarget: {
                  method: ApplicationMethod.ONLINE_URL,
                  applyUrl: 'https://example.test/apply',
                  applyEmail: null,
                  evidence: null,
                },
                job: matchableJob(),
              },
            ]
          : [],
    };
    const guarded = new ScoreMatches({
      profiles,
      jobs: staleReader,
      matches: matchRepository,
      facts: new PrismaNotificationFactsReader(prisma),
    });

    const result = await guarded.run({ now: FIRST_NOW });

    expect(result).toEqual({
      profiles: 1,
      jobScores: 1,
      skipped: 1,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      notificationsReserved: 0,
    });
    expect(await prisma.jobMatch.count({ where: { userId } })).toBe(0);
  });
});

/**
 * SRS 3.2 eligibility, evaluated inside the scoring run (ENG-027): a scored job that is also
 * eligible leaves with an outbox row in the same transaction. These cases pin that the gate runs
 * at all, that it reads the *stored* job's application path, and that both table predicates
 * (already notified, rejected) actually reach the policy.
 */
describe('notification eligibility inside the scoring run (SRS 3.2, ENG-027)', () => {
  /** Give one fixture job a real application path; the others have none (SRS 3.5). */
  async function giveApplicationPath(targetJobId: string): Promise<void> {
    await prisma.job.update({
      where: { id: targetJobId },
      data: { applicationMethod: ApplicationMethod.EMAIL, applyEmail: 'jobs@example.test' },
    });
  }

  it('reserves for the one eligible job and none for the jobs with no application path', async () => {
    await profiles.saveForUser({ userId, profile: profile() });
    await giveApplicationPath(jobIds[0]);

    const result = await scoring.run({ now: FIRST_NOW });

    expect(result.jobScores).toBe(3);
    expect(result.notificationsReserved).toBe(1);

    const match = await prisma.jobMatch.findFirstOrThrow({ where: { userId, jobId: jobIds[0] } });
    const rows = await prisma.notificationOutbox.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId,
      jobId: jobIds[0],
      // ENG-027: the row points at the match it was written with.
      jobMatchId: match.id,
      notificationType: 'NEW_MATCH',
      event: 'NEW_MATCH',
      status: 'PENDING',
    });
    // The payload records the verdict, so a later delivery can say why it was sent.
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.matcherVersion).toBe(MATCHER_VERSION);
    expect(payload.eligibilityVersion).toBe(NOTIFICATION_ELIGIBILITY_VERSION);
    expect(String(payload.eligibilityExplanation)).toContain('eligible');
    expect(payload.score).toBe(match.score);
    expect(rows[0].nextAttemptAt.toISOString()).toBe(FIRST_NOW.toISOString());
  });

  it('does not reserve a second time for an event that was already reserved', async () => {
    await profiles.saveForUser({ userId, profile: profile() });
    await giveApplicationPath(jobIds[0]);
    await scoring.run({ now: FIRST_NOW });

    const rerun = await scoring.run({ now: FIRST_NOW });

    expect(rerun.notificationsReserved).toBe(0);
    expect(await prisma.notificationOutbox.count()).toBe(1);
  });

  it('does not reserve for a job the user rejected', async () => {
    await profiles.saveForUser({ userId, profile: profile() });
    await giveApplicationPath(jobIds[0]);
    // A rejection is only recorded against a notification that was sent. This one is for a
    // different event, so the job is rejected but not "already notified" for this event: the two
    // predicates have to be consulted separately.
    const past = await prisma.notificationOutbox.create({
      data: {
        userId,
        jobId: jobIds[0],
        notificationType: 'NEW_MATCH',
        event: 'SALARY_DISCLOSED',
        payload: {},
      },
      select: { id: true },
    });
    await prisma.notificationFeedback.create({
      data: { notificationId: past.id, value: 'NOT_RELEVANT' },
    });

    const result = await scoring.run({ now: FIRST_NOW });

    expect(result.notificationsReserved).toBe(0);
    expect(await prisma.notificationOutbox.count()).toBe(1);
  });
});
