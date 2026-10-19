import { describe, expect, it } from 'vitest';
import { matchInputHashOf } from '@domain/matching';
import {
  CalendarType,
  DescriptionQuality,
  EmploymentType,
  LocationCategory,
  RemoteStatus,
  SalaryPeriod,
  SalaryType,
} from '@domain/enums';
import { asDecimalAmount, asProbability, type MatchableJob } from '@domain/types';

/**
 * Identity of one scoring input set (ADR-0005; D2).
 *
 * The properties that matter: identical inputs hash identically whatever order they were built
 * in; every input that can move the score changes the hash; and a field no factor reads does
 * *not*, because hashing it would manufacture a "changed input" that cannot have changed the
 * output.
 */

function job(overrides: Partial<MatchableJob> = {}): MatchableJob {
  return {
    title: 'Backend Engineer',
    descriptionQuality: DescriptionQuality.SUFFICIENT,
    locationText: 'Addis Ababa',
    locationCategory: LocationCategory.ADDIS_ABABA,
    remoteStatus: RemoteStatus.ONSITE,
    employmentType: EmploymentType.FULL_TIME,
    salary: {
      type: SalaryType.RANGE,
      min: asDecimalAmount('50000.00'),
      max: asDecimalAmount('80000.00'),
      currency: 'ETB',
      period: SalaryPeriod.MONTH,
      evidence: 'ETB 50,000 - 80,000 per month',
      confidence: asProbability(0.9),
    },
    publishedDate: {
      calendar: CalendarType.GREGORIAN,
      publishedAt: new Date('2026-10-01T00:00:00.000Z'),
      originalText: '1 October 2026',
      confidence: asProbability(0.95),
      conversionMethod: null,
    },
    skills: [],
    requiredExperience: null,
    ...overrides,
  };
}

const base = { profileVersion: 'v1:aaaa', matcherVersion: '1.0.0', job: job() };

describe('matchInputHashOf', () => {
  it('is stable for identical inputs', () => {
    expect(matchInputHashOf({ ...base, job: job() })).toBe(matchInputHashOf({ ...base, job: job() }));
    expect(matchInputHashOf(base)).toMatch(/^v1:[0-9a-f]{32}$/);
  });

  it('changes when the profile revision changes', () => {
    expect(matchInputHashOf({ ...base, profileVersion: 'v1:bbbb' })).not.toBe(matchInputHashOf(base));
  });

  it('changes when the matcher version changes', () => {
    expect(matchInputHashOf({ ...base, matcherVersion: '1.0.1' })).not.toBe(matchInputHashOf(base));
  });

  it('changes when any job fact that feeds scoring changes', () => {
    const recorded = matchInputHashOf(base);
    const variations: MatchableJob[] = [
      job({ title: 'Data Engineer' }),
      job({ descriptionQuality: DescriptionQuality.PARTIAL }),
      job({ locationCategory: LocationCategory.ETHIOPIA_CITY }),
      job({ remoteStatus: RemoteStatus.REMOTE }),
      job({ employmentType: EmploymentType.CONTRACT }),
      job({ salary: { ...job().salary, min: asDecimalAmount('50001.00') } }),
      job({ salary: { ...job().salary, period: SalaryPeriod.YEAR } }),
      job({ publishedDate: { ...job().publishedDate, publishedAt: new Date('2026-10-02T00:00:00.000Z') } }),
      job({ publishedDate: { ...job().publishedDate, confidence: asProbability(0.5) } }),
      job({ requiredExperience: { years: 3, confidence: asProbability(0.8) } }),
    ];

    for (const variation of variations) {
      expect(matchInputHashOf({ ...base, job: variation })).not.toBe(recorded);
    }
  });

  it('ignores the raw date text, which no factor reads', () => {
    const reworded = job({
      publishedDate: { ...job().publishedDate, originalText: 'October 1st, 2026' },
    });

    expect(matchInputHashOf({ ...base, job: reworded })).toBe(matchInputHashOf(base));
  });
});
