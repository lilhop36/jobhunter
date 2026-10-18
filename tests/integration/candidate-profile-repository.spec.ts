import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { EmploymentType, LocationCategory, RelocationPreference, RemotePreference, SalaryPeriod, SkillEvidence } from '@domain/enums';
import { asDecimalAmount, asProbability, CandidateProfile } from '@domain/types';
import { UnversionedCandidateProfile } from '@domain/matching/profile-version';
import { PrismaCandidateProfileRepository } from '@infrastructure/ingestion/prisma-candidate-profile-repository';
import { applyTestMigrations, createTestPrismaClient, truncateAll } from '../support/db';

/**
 * Real-PostgreSQL tests for candidate profile persistence (FR-012, SRS 4.5/5.2).
 *
 * A profile is one candidate's declared facts: nothing here is derived from
 * postings, a value the candidate never stated comes back as null/empty so the
 * matcher can treat it as UNKNOWN (ENG-001), and the vocabulary is field-agnostic
 * so a second candidate in an unrelated field is data, not a redesign.
 */

const EMAIL = 'candidate@example.com';

function baseProfile(overrides: Partial<UnversionedCandidateProfile> = {}): UnversionedCandidateProfile {
  return {
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
    skills: [
      { canonicalSkill: 'TypeScript', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) },
      { canonicalSkill: 'node.js', skillType: SkillEvidence.CANONICAL_ALIAS, confidence: asProbability(0.9) },
    ],
    targetRoles: [{ title: 'Software Engineer', aliases: ['Backend Engineer'] }],
    locationPreferences: [{ category: LocationCategory.ADDIS_ABABA, text: null }],
    ...overrides,
  };
}

describe('PrismaCandidateProfileRepository', () => {
  const prisma = createTestPrismaClient();
  const repository = new PrismaCandidateProfileRepository(prisma);

  beforeAll(() => applyTestMigrations());
  beforeEach(() => truncateAll(prisma));
  afterAll(() => prisma.$disconnect());

  it('returns an empty list before anything is seeded (matching has nothing to score against)', async () => {
    expect(await repository.listProfiles()).toEqual([]);
  });

  it('creates the profile with all children and returns the derived version', async () => {
    const user = await prisma.user.create({ data: { email: EMAIL }, select: { id: true } });
    const stored = await repository.saveForUser({ userId: user.id, profile: baseProfile() });

    expect(stored.userId).toBe(user.id);
    expect(stored.profileVersion).toMatch(/^v1:[0-9a-f]{16}$/);
    expect(stored.profile.skills).toHaveLength(2);
    expect(stored.profile.targetRoles).toHaveLength(1);
    expect(stored.profile.locationPreferences).toHaveLength(1);
    expect(stored.profile.experienceYears).toBe(3);
    expect(stored.profile.salaryPreference?.min).toBe('20000.00');
  });

  it('replaces child rows on re-save rather than appending', async () => {
    const user = await prisma.user.create({ data: { email: EMAIL }, select: { id: true } });
    await repository.saveForUser({ userId: user.id, profile: baseProfile() });

    const second = await repository.saveForUser({
      userId: user.id,
      profile: baseProfile({ skills: [{ canonicalSkill: 'Rust', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) }] }),
    });

    expect(second.profile.skills).toHaveLength(1);
    expect(second.profile.skills[0].canonicalSkill).toBe('Rust');
    expect(await prisma.candidateSkill.count()).toBe(1);
    expect(await prisma.targetRole.count()).toBe(1);
    expect(await prisma.locationPreference.count()).toBe(1);
  });

  it('keeps the profile row id stable across saves', async () => {
    const user = await prisma.user.create({ data: { email: EMAIL }, select: { id: true } });
    const first = await repository.saveForUser({ userId: user.id, profile: baseProfile() });
    const second = await repository.saveForUser({ userId: user.id, profile: baseProfile({ experienceYears: 4 }) });
    expect(second.id).toBe(first.id);
    expect(await prisma.candidateProfile.count()).toBe(1);
  });

  it('keeps the version on identical content and changes it on any edit', async () => {
    const user = await prisma.user.create({ data: { email: EMAIL }, select: { id: true } });
    const first = await repository.saveForUser({ userId: user.id, profile: baseProfile() });
    const same = await repository.saveForUser({ userId: user.id, profile: baseProfile() });
    expect(same.profileVersion).toBe(first.profileVersion);

    const edited = await repository.saveForUser({ userId: user.id, profile: baseProfile({ experienceYears: 4 }) });
    expect(edited.profileVersion).not.toBe(first.profileVersion);
  });

  it('maps a stated salary preference and an absent one distinctly (ENG-001)', async () => {
    const user = await prisma.user.create({ data: { email: EMAIL }, select: { id: true } });

    const withSalary = await repository.saveForUser({
      userId: user.id,
      profile: baseProfile({
        salaryPreference: { min: null, currency: null, period: null, requireDisclosed: true },
      }),
    });
    expect(withSalary.profile.salaryPreference).not.toBeNull();
    expect(withSalary.profile.salaryPreference?.requireDisclosed).toBe(true);
    expect(withSalary.profile.salaryPreference?.min).toBeNull();

    const withoutSalary = await repository.saveForUser({
      userId: user.id,
      profile: baseProfile({ salaryPreference: null }),
    });
    expect(withoutSalary.profile.salaryPreference).toBeNull();
  });

  it('round-trips every stated field without loss (FR-012, SRS 5.2)', async () => {
    const user = await prisma.user.create({ data: { email: EMAIL }, select: { id: true } });
    const input = baseProfile({
      experienceYears: 5,
      remotePreference: RemotePreference.REMOTE_PREFERRED,
      relocationPreference: RelocationPreference.NOT_WILLING,
      employmentPreferences: [EmploymentType.CONTRACT, EmploymentType.FREELANCE],
      skills: [
        { canonicalSkill: 'AWS', skillType: SkillEvidence.AI_SUGGESTED, confidence: asProbability(0.7) },
      ],
      targetRoles: [{ title: 'DevOps Engineer', aliases: ['SRE'] }],
      locationPreferences: [{ category: LocationCategory.UNKNOWN, text: 'Bishoftu' }],
    });
    const stored = await repository.saveForUser({ userId: user.id, profile: input });

    const loaded = (await repository.listProfiles())[0];
    expect(loaded).toBeDefined();
    expect(loaded.profileVersion).toBe(stored.profileVersion);
    // compare without profileVersion (the domain type carries it; input is unversioned)
    const { profileVersion: _a, ...loadedWithoutVersion } = loaded.profile;
    const { profileVersion: _b, ...inputWithoutVersion } = { profileVersion: stored.profileVersion, ...input } as CandidateProfile;
    expect(loadedWithoutVersion).toEqual(inputWithoutVersion);
  });

  it('enforces one profile per user at the database level (FR-012)', async () => {
    const user = await prisma.user.create({ data: { email: EMAIL }, select: { id: true } });
    await repository.saveForUser({ userId: user.id, profile: baseProfile() });

    await expect(
      prisma.candidateProfile.create({
        data: {
          userId: user.id,
          remotePreference: RemotePreference.NO_PREFERENCE,
          relocationPreference: RelocationPreference.WILLING,
          profileVersion: 'v1:0000000000000000',
        },
      }),
    ).rejects.toThrow();
  });

  it('lists every candidate profile independently — no single-profile assumption', async () => {
    const software = await prisma.user.create({ data: { email: EMAIL }, select: { id: true } });
    const nurse = await prisma.user.create({ data: { email: 'nurse@example.com' }, select: { id: true } });

    const softwareProfile = await repository.saveForUser({ userId: software.id, profile: baseProfile() });
    const nurseProfile = await repository.saveForUser({
      userId: nurse.id,
      profile: baseProfile({
        skills: [{ canonicalSkill: 'Patient Care', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) }],
        targetRoles: [{ title: 'Registered Nurse', aliases: ['Staff Nurse'] }],
      }),
    });

    const profiles = await repository.listProfiles();
    expect(profiles).toHaveLength(2);
    expect(new Set(profiles.map((entry) => entry.userId))).toEqual(new Set([software.id, nurse.id]));

    // Each candidate keeps its own facts and its own version.
    const loadedSoftware = profiles.find((entry) => entry.userId === software.id);
    const loadedNurse = profiles.find((entry) => entry.userId === nurse.id);
    expect(loadedSoftware?.profile.skills.map((skill) => skill.canonicalSkill)).toContain('TypeScript');
    expect(loadedNurse?.profile.skills.map((skill) => skill.canonicalSkill)).toEqual(['Patient Care']);
    expect(loadedSoftware?.profileVersion).toBe(softwareProfile.profileVersion);
    expect(loadedNurse?.profileVersion).toBe(nurseProfile.profileVersion);
    expect(loadedSoftware?.profileVersion).not.toBe(loadedNurse?.profileVersion);

    // Re-seeding one candidate leaves the other untouched.
    await repository.saveForUser({ userId: software.id, profile: baseProfile({ experienceYears: 9 }) });
    const after = await repository.listProfiles();
    expect(after).toHaveLength(2);
    expect(after.find((entry) => entry.userId === nurse.id)?.profileVersion).toBe(nurseProfile.profileVersion);
  });

  it('returns profiles in a stable order across calls', async () => {
    const first = await prisma.user.create({ data: { email: EMAIL }, select: { id: true } });
    const second = await prisma.user.create({ data: { email: 'second@example.com' }, select: { id: true } });
    await repository.saveForUser({ userId: first.id, profile: baseProfile() });
    await repository.saveForUser({ userId: second.id, profile: baseProfile() });

    const orderA = (await repository.listProfiles()).map((entry) => entry.id);
    const orderB = (await repository.listProfiles()).map((entry) => entry.id);
    expect(orderB).toEqual(orderA);
  });

  it('rejects an exact duplicate of a canonical skill (SRS 5.6)', async () => {
    const user = await prisma.user.create({ data: { email: EMAIL }, select: { id: true } });
    const profile = await repository.saveForUser({ userId: user.id, profile: baseProfile() });

    await expect(
      prisma.candidateSkill.create({
        data: {
          candidateProfileId: profile.id,
          canonicalSkill: 'TypeScript',
          skillType: SkillEvidence.EXACT_MATCH,
          confidence: 1,
        },
      }),
    ).rejects.toThrow();
  });
});
