import { describe, expect, it } from 'vitest';
import { profileVersionOf } from '@domain/matching/profile-version';
import type { UnversionedCandidateProfile } from '@domain/matching/profile-version';
import { asDecimalAmount, asProbability } from '@domain/types';
import { EmploymentType, LocationCategory, RelocationPreference, RemotePreference, SalaryPeriod, SkillEvidence } from '@domain/enums';

const BASE: UnversionedCandidateProfile = {
  experienceYears: 3,
  remotePreference: RemotePreference.NO_PREFERENCE,
  relocationPreference: RelocationPreference.WILLING,
  salaryPreference: {
    min: asDecimalAmount('20000.00'),
    currency: 'ETB',
    period: SalaryPeriod.MONTH,
    requireDisclosed: false,
  },
  employmentPreferences: [EmploymentType.FULL_TIME],
  skills: [{ canonicalSkill: 'TypeScript', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) }],
  targetRoles: [{ title: 'Software Engineer', aliases: [] }],
  locationPreferences: [{ category: LocationCategory.ADDIS_ABABA, text: null }],
};

describe('profileVersionOf (SRS 5.2 profileVersion, ENG-012/ENG-013)', () => {
  it('is deterministic and stable under key reordering', () => {
    const reordered = JSON.parse(JSON.stringify(BASE));
    const version = profileVersionOf(BASE);
    expect(version).toMatch(/^v1:[0-9a-f]{16}$/);
    expect(profileVersionOf(reordered)).toBe(version);
  });

  it('ignores list order (the matcher sorts its own output)', () => {
    const shuffled = {
      ...BASE,
      skills: [{ canonicalSkill: 'Rust', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) }, BASE.skills[0]],
      employmentPreferences: [EmploymentType.PART_TIME, EmploymentType.FULL_TIME],
    };
    const reorderedShuffle = {
      ...BASE,
      skills: [BASE.skills[0], shuffled.skills[0]],
      employmentPreferences: [EmploymentType.FULL_TIME, EmploymentType.PART_TIME],
    };
    expect(profileVersionOf(shuffled)).toBe(profileVersionOf(reorderedShuffle));
  });

  it('changes when any scoring input changes', () => {
    const baseVersion = profileVersionOf(BASE);
    expect(profileVersionOf({ ...BASE, experienceYears: 4 })).not.toBe(baseVersion);
    expect(profileVersionOf({ ...BASE, skills: [] })).not.toBe(baseVersion);
    expect(profileVersionOf({ ...BASE, salaryPreference: null })).not.toBe(baseVersion);
    expect(profileVersionOf({ ...BASE, targetRoles: [] })).not.toBe(baseVersion);
  });

  it('keeps the version when the content is unchanged', () => {
    expect(profileVersionOf({ ...BASE })).toBe(profileVersionOf(BASE));
  });
});
