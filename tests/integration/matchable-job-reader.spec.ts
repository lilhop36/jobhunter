import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  CalendarType,
  DescriptionQuality,
  EmploymentType,
  LifecycleStatus,
  LocationCategory,
  RemoteStatus,
  SalaryPeriod,
  SalaryType,
} from '@domain/enums';
import { isMatchable } from '@domain/matching';
import { asProbability, type MatchableJob } from '@domain/types';
import { PrismaMatchableJobReader } from '@infrastructure/matching/prisma-matchable-job-reader';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * Real-PostgreSQL tests for the scoring-view reader (SRS 5.2; ADR-0005; D4).
 *
 * The properties that matter here are fidelity and eligibility:
 *   - only ACTIVE jobs with a usable description are visible at all;
 *   - every column is mapped as stored, with money crossing the boundary as an exact decimal
 *     *string* (ENG-006) and never through a binary float;
 *   - a page is a keyset window, so concurrent inserts cannot skip or repeat a job;
 *   - job-side skills/experience are honestly UNKNOWN, not "none".
 */

const prisma = createTestPrismaClient();
const reader = new PrismaMatchableJobReader(prisma);

let counter = 0;
let sourceId: string;

beforeAll(() => {
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);
  const source = await prisma.jobSource.create({
    data: { name: `src-${Date.now()}-${counter++}`, adapterType: 'FAKE', adapterVersion: '1.0.0' },
    select: { id: true },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function createJob(overrides: Partial<Prisma.JobUncheckedCreateInput> = {}) {
  return prisma.job.create({
    data: {
      sourceId,
      identityKey: `k-${counter++}`,
      descriptionQuality: DescriptionQuality.SUFFICIENT,
      ...overrides,
    },
    select: { id: true },
  });
}

/** A MatchableJob for exercising the policy predicate without a database row. */
function matchable(overrides: Partial<MatchableJob> = {}): MatchableJob {
  return {
    title: 'Backend Engineer',
    descriptionQuality: DescriptionQuality.SUFFICIENT,
    locationText: 'Addis Ababa',
    locationCategory: LocationCategory.ADDIS_ABABA,
    remoteStatus: RemoteStatus.ONSITE,
    employmentType: EmploymentType.FULL_TIME,
    salary: {
      type: SalaryType.UNKNOWN,
      min: null,
      max: null,
      currency: null,
      period: SalaryPeriod.UNKNOWN,
      evidence: null,
      confidence: asProbability(0),
    },
    publishedDate: {
      calendar: CalendarType.UNKNOWN,
      publishedAt: null,
      originalText: null,
      confidence: asProbability(0),
      conversionMethod: null,
    },
    skills: [],
    requiredExperience: null,
    ...overrides,
  };
}

describe('matchable-job policy', () => {
  it('admits ACTIVE jobs with a usable description and rejects the rest', () => {
    expect(isMatchable(LifecycleStatus.ACTIVE, matchable())).toBe(true);
    expect(isMatchable(LifecycleStatus.ACTIVE, matchable({ descriptionQuality: DescriptionQuality.PARTIAL }))).toBe(true);

    for (const status of [LifecycleStatus.EXPIRED, LifecycleStatus.REMOVED, LifecycleStatus.NOT_FOUND]) {
      expect(isMatchable(status, matchable())).toBe(false);
    }
    // UNUSABLE is "not collected well enough to score", not "scores zero".
    expect(isMatchable(LifecycleStatus.ACTIVE, matchable({ descriptionQuality: DescriptionQuality.UNUSABLE }))).toBe(
      false,
    );
  });
});

describe('PrismaMatchableJobReader.listMatchableJobs', () => {
  it('returns only ACTIVE jobs with a usable description, in agreement with the policy', async () => {
    const sufficient = await createJob();
    const partial = await createJob({ descriptionQuality: DescriptionQuality.PARTIAL });
    await createJob({ descriptionQuality: DescriptionQuality.UNUSABLE });
    await createJob({ lifecycleStatus: LifecycleStatus.EXPIRED });
    await createJob({ lifecycleStatus: LifecycleStatus.REMOVED });

    const page = await reader.listMatchableJobs({ limit: 50 });

    expect(page.map((batch) => batch.jobId).sort()).toEqual([sufficient.id, partial.id].sort());
    for (const batch of page) {
      expect(isMatchable(batch.lifecycleStatus, batch.job)).toBe(true);
      expect(batch.sourceId).toBe(sourceId);
    }
  });

  it('maps every stored column as-is, with money kept as an exact decimal string', async () => {
    const publishedAt = new Date('2026-10-01T08:30:00.000Z');
    const job = await createJob({
      title: 'Senior Backend Engineer',
      locationText: 'Addis Ababa, Bole',
      locationCategory: LocationCategory.ADDIS_ABABA,
      remoteStatus: RemoteStatus.HYBRID,
      employmentType: EmploymentType.CONTRACT,
      salaryType: SalaryType.RANGE,
      salaryMin: '1250.50',
      salaryMax: '2000.00',
      salaryCurrency: 'ETB',
      salaryPeriod: SalaryPeriod.MONTH,
      salaryEvidence: 'ETB 1,250.50 - 2,000.00 per month',
      salaryConfidence: '0.900',
      publishedCalendar: CalendarType.ETHIOPIAN,
      originalPublishedDateText: 'ጥቅምት 21, 2018',
      publishedAt,
      dateConfidence: '0.950',
      provenance: {
        publishedAt: {
          provenance: 'SOURCE',
          conversionMethod: 'ETHIOPIAN_CALENDAR_V1',
          evidence: 'ጥቅምት 21, 2018',
        },
      },
    });

    const [batch] = await reader.listMatchableJobs({ limit: 1 });

    expect(batch.jobId).toBe(job.id);
    expect(batch.job.title).toBe('Senior Backend Engineer');
    expect(batch.job.locationCategory).toBe(LocationCategory.ADDIS_ABABA);
    expect(batch.job.remoteStatus).toBe(RemoteStatus.HYBRID);
    expect(batch.job.employmentType).toBe(EmploymentType.CONTRACT);

    // Exact decimals: strings at the storage scale, never `Number`.
    expect(typeof batch.job.salary.min).toBe('string');
    expect(batch.job.salary.min).toBe('1250.50');
    expect(batch.job.salary.max).toBe('2000.00');
    expect(batch.job.salary.type).toBe(SalaryType.RANGE);
    expect(batch.job.salary.currency).toBe('ETB');
    expect(batch.job.salary.period).toBe(SalaryPeriod.MONTH);
    expect(batch.job.salary.evidence).toBe('ETB 1,250.50 - 2,000.00 per month');
    expect(batch.job.salary.confidence).toBeCloseTo(0.9, 6);

    expect(batch.job.publishedDate.calendar).toBe(CalendarType.ETHIOPIAN);
    expect(batch.job.publishedDate.publishedAt?.toISOString()).toBe('2026-10-01T08:30:00.000Z');
    expect(batch.job.publishedDate.originalText).toBe('ጥቅምት 21, 2018');
    expect(batch.job.publishedDate.confidence).toBeCloseTo(0.95, 6);
    // Recorded by ingestion in the provenance map, not inferred from the calendar.
    expect(batch.job.publishedDate.conversionMethod).toBe('ETHIOPIAN_CALENDAR_V1');
  });

  it('keeps a large amount exact rather than rounding it to a float', async () => {
    await createJob({ salaryType: SalaryType.EXACT, salaryMin: '999999999999.99', salaryCurrency: 'ETB' });

    const [batch] = await reader.listMatchableJobs({ limit: 1 });

    expect(batch.job.salary.min).toBe('999999999999.99');
  });

  it('reads an undisclosed salary as UNKNOWN rather than as zero', async () => {
    await createJob({ salaryType: SalaryType.NOT_DISCLOSED });

    const [batch] = await reader.listMatchableJobs({ limit: 1 });

    expect(batch.job.salary.type).toBe(SalaryType.NOT_DISCLOSED);
    expect(batch.job.salary.min).toBeNull();
    expect(batch.job.salary.max).toBeNull();
    expect(batch.job.salary.currency).toBeNull();
    expect(batch.job.salary.period).toBe(SalaryPeriod.UNKNOWN);
    expect(batch.job.salary.confidence).toBe(0);
    expect(batch.job.publishedDate.publishedAt).toBeNull();
    expect(batch.job.publishedDate.conversionMethod).toBeNull();
  });

  it('leaves job-side skills and required experience UNKNOWN until a producer exists', async () => {
    await createJob();

    const [batch] = await reader.listMatchableJobs({ limit: 1 });

    // Documents the interim state of ADR-0005 §2 rather than leaving it to a comment elsewhere.
    expect(batch.job.skills).toEqual([]);
    expect(batch.job.requiredExperience).toBeNull();
  });

  it('pages with a keyset cursor, without gaps or repeats', async () => {
    const created = [];
    for (let index = 0; index < 5; index += 1) created.push(await createJob());

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const batch = await reader.listMatchableJobs({ limit: 2, afterJobId: cursor });
      if (batch.length === 0) break;
      seen.push(...batch.map((row) => row.jobId));
      cursor = batch[batch.length - 1].jobId;
    }

    expect(seen).toHaveLength(created.length);
    expect(new Set(seen).size).toBe(created.length);
    // The ordering key is the primary key, so the walk is strictly ascending.
    expect([...seen].sort()).toEqual(seen);
  });

  it('is scoped to one source when asked', async () => {
    const mine = await createJob();
    const other = await prisma.jobSource.create({
      data: { name: `src-${Date.now()}-${counter++}`, adapterType: 'FAKE', adapterVersion: '1.0.0' },
      select: { id: true },
    });
    await prisma.job.create({
      data: {
        sourceId: other.id,
        identityKey: `k-${counter++}`,
        descriptionQuality: DescriptionQuality.SUFFICIENT,
      },
    });

    const page = await reader.listMatchableJobs({ limit: 50, sourceId });

    expect(page.map((batch) => batch.jobId)).toEqual([mine.id]);
  });

  it('rejects a page size below one instead of returning an unbounded page', async () => {
    await expect(reader.listMatchableJobs({ limit: 0 })).rejects.toThrow(/at least 1 job/);
  });
});
