import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  CalendarType,
  DescriptionQuality,
  EmploymentType,
  LocationCategory,
  RemoteStatus,
  RelocationPreference,
  RemotePreference,
  SalaryPeriod,
  SalaryType,
  SkillEvidence,
} from '@domain/enums';
import { asDecimalAmount, asProbability } from '@domain/types';
import type { UnversionedCandidateProfile } from '@domain/matching';
import {
  MATCH_SCORING_TASK_TYPE,
  RequestMatchBackfill,
  ScoreMatches,
  createMatchScoringHandler,
  matchScoringDedupeKey,
  type MatchScoringTaskPayload,
} from '@application/matching';
import { PrismaCandidateProfileRepository } from '@infrastructure/ingestion/prisma-candidate-profile-repository';
import { PrismaJobMatchRepository } from '@infrastructure/ingestion/prisma-job-match-repository';
import { PrismaJobSourceRepository } from '@infrastructure/ingestion/prisma-job-source-repository';
import { PrismaMatchableJobReader } from '@infrastructure/matching/prisma-matchable-job-reader';
import { PrismaNotificationFactsReader } from '@infrastructure/matching/prisma-notification-facts-reader';
import { PrismaWorkTaskRepository } from '@infrastructure/work-tasks/prisma-work-task-repository';
import type { MatchableJobReader } from '@ports/matchable-job-reader';
import { silentWorkerLogger, type WorkerLogger } from '@ports/worker-logger';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * The `match.score` worker task (SRS 11.2, FR-013). What is pinned here is the contract the
 * queue depends on: the handler scores the task's source, reports what it did, stops at a job
 * boundary on shutdown, and converges on one row per job when the attempt crashes midway and is
 * retried. The backfill entry point is pinned to one deduped task per enabled source.
 */

const prisma = createTestPrismaClient();
const profiles = new PrismaCandidateProfileRepository(prisma);
const reader = new PrismaMatchableJobReader(prisma);
const matchRepository = new PrismaJobMatchRepository(prisma);
const jobSources = new PrismaJobSourceRepository(prisma);
const tasks = new PrismaWorkTaskRepository(prisma);
const scoring = new ScoreMatches({
  profiles,
  jobs: reader,
  matches: matchRepository,
  facts: new PrismaNotificationFactsReader(prisma),
});

const FIRST_NOW = new Date('2026-10-05T00:00:00.000Z');
const SIGNAL = new AbortController().signal;

let counter = 0;
let userId: string;
let sourceId: string;

beforeAll(() => {
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);

  const user = await prisma.user.create({
    data: { email: `match-task-${Date.now()}-${counter++}@example.test` },
    select: { id: true },
  });
  userId = user.id;
  await profiles.saveForUser({ userId, profile: profile() });

  const source = await createSource();
  sourceId = source;

  await createJob();
  await createJob({ title: 'Senior Backend Engineer' });
  await createJob({
    title: 'Data Analyst',
    locationCategory: LocationCategory.ETHIOPIA_CITY,
    locationText: 'Jimma',
  });
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
      {
        canonicalSkill: 'TypeScript',
        skillType: SkillEvidence.EXACT_MATCH,
        confidence: asProbability(1),
      },
    ],
    targetRoles: [{ title: 'Backend Engineer', aliases: [] }],
    locationPreferences: [{ category: LocationCategory.ADDIS_ABABA, text: null }],
    ...overrides,
  };
}

async function createSource(overrides: Partial<Prisma.JobSourceUncheckedCreateInput> = {}): Promise<string> {
  const row = await prisma.jobSource.create({
    data: { name: `src-${Date.now()}-${counter++}`, adapterType: 'FAKE', adapterVersion: '1.0.0', ...overrides },
    select: { id: true },
  });
  return row.id;
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

function capturingLogger(sink: { message: string; meta?: unknown }[]): WorkerLogger {
  const record = (message: string, meta?: unknown): void => {
    sink.push({ message, meta });
  };
  return { info: record, warn: record, error: record };
}

async function enqueueTask(payload: MatchScoringTaskPayload) {
  return tasks.enqueue({
    type: MATCH_SCORING_TASK_TYPE,
    payload,
    dedupeKey: matchScoringDedupeKey(payload),
  });
}

function handlerFor(
  useCase: ScoreMatches,
  pageSize?: number,
  logger: WorkerLogger = silentWorkerLogger,
) {
  return createMatchScoringHandler({
    scoring: useCase,
    now: () => FIRST_NOW,
    logger,
    ...(pageSize === undefined ? {} : { pageSize }),
  });
}

describe('match.scoring handler', () => {
  it('scores the task source and reports what it did', async () => {
    const logs: { message: string; meta?: unknown }[] = [];
    const task = await enqueueTask({ sourceId, sourceRunId: 'run-1', trigger: 'SOURCE_RUN' });

    await handlerFor(scoring, undefined, capturingLogger(logs))({ task, signal: SIGNAL });

    expect(await prisma.jobMatch.count({ where: { userId } })).toBe(3);
    const entry = logs.find((row) => row.message === 'scored matchable jobs');
    expect(entry?.meta).toMatchObject({
      sourceId,
      sourceRunId: 'run-1',
      trigger: 'SOURCE_RUN',
      profiles: 1,
      jobScores: 3,
      inserted: 3,
      unchanged: 0,
    });
  });

  it('scores only the task source, not every source', async () => {
    const otherSource = await createSource();
    const otherJob = await createJob({ sourceId: otherSource });
    const task = await enqueueTask({ sourceId, sourceRunId: 'run-1', trigger: 'SOURCE_RUN' });

    await handlerFor(scoring)({ task, signal: SIGNAL });

    const rows = await prisma.jobMatch.findMany({ where: { userId }, select: { jobId: true } });
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.jobId === otherJob)).toBe(false);
  });

  it('converges on one row per job when the attempt crashes midway and is retried', async () => {
    const task = await enqueueTask({ sourceId, sourceRunId: 'run-1', trigger: 'SOURCE_RUN' });

    let pageReads = 0;
    const crashingReader: MatchableJobReader = {
      listMatchableJobs: async (options) => {
        pageReads += 1;
        if (pageReads === 2) throw new Error('simulated crash mid-page');
        return reader.listMatchableJobs(options);
      },
    };
    const crashing = new ScoreMatches({
      profiles,
      jobs: crashingReader,
      matches: matchRepository,
      facts: new PrismaNotificationFactsReader(prisma),
    });

    await expect(handlerFor(crashing, 2)({ task, signal: SIGNAL })).rejects.toThrow(
      'simulated crash mid-page',
    );
    // The first page was durably scored before the failure: partial progress, never partial rows.
    expect(await prisma.jobMatch.count({ where: { userId } })).toBe(2);

    // The retry is the same task with the same payload; it finishes the work it lost.
    await handlerFor(scoring, 2)({ task, signal: SIGNAL });

    const rows = await prisma.jobMatch.findMany({ where: { userId } });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.jobId)).size).toBe(3);
  });

  it('stops at a job boundary when the worker is shutting down', async () => {
    const abort = new AbortController();
    abort.abort();
    const task = await enqueueTask({ sourceId, sourceRunId: 'run-1', trigger: 'SOURCE_RUN' });

    await expect(handlerFor(scoring)({ task, signal: abort.signal })).rejects.toThrow(
      /aborted before completing/,
    );
    expect(await prisma.jobMatch.count({ where: { userId } })).toBe(0);
  });
});

describe('RequestMatchBackfill.run', () => {
  it('enqueues one deduped task per enabled source', async () => {
    const disabled = await createSource({ enabled: false });
    const backfill = new RequestMatchBackfill({ sources: jobSources, tasks });

    expect(await backfill.run({ reason: 'PROFILE_CHANGED' })).toEqual({
      enqueued: [sourceId],
      alreadyQueued: [],
    });

    // A second request while the first is still pending coalesces instead of stacking.
    expect(await backfill.run({ reason: 'MATCHER_VERSION_CHANGED' })).toEqual({
      enqueued: [],
      alreadyQueued: [sourceId],
    });

    const queued = await prisma.workTask.findMany({ where: { type: MATCH_SCORING_TASK_TYPE } });
    expect(queued).toHaveLength(1);
    expect(queued[0].dedupeKey).toBe(`${MATCH_SCORING_TASK_TYPE}:source:${sourceId}`);
    expect(queued[0].payload).toMatchObject({ sourceId, sourceRunId: null, trigger: 'PROFILE_CHANGED' });
    expect(queued.some((row) => row.dedupeKey?.includes(disabled))).toBe(false);
  });
});
