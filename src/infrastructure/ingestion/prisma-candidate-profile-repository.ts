import { Prisma, PrismaClient } from '@prisma/client';
import {
  EmploymentType,
  LocationCategory,
  RelocationPreference,
  RemotePreference,
  SalaryPeriod,
  SkillEvidence,
} from '@domain/enums';
import {
  asDecimalAmount,
  asProbability,
  CandidateSkill,
  LocationPreference,
  SalaryPreference,
  TargetRole,
} from '@domain/types';
import { profileVersionOf } from '@domain/matching/profile-version';
import {
  CandidateProfileRepository,
  SaveCandidateProfileInput,
  StoredCandidateProfile,
} from '@ports/candidate-profile-repository';

export const PROFILE_INCLUDE = {
  skills: true,
  targetRoles: true,
  locationPreferences: true,
} as const;

type ProfileRow = Prisma.CandidateProfileGetPayload<{ include: typeof PROFILE_INCLUDE }>;

/**
 * Prisma-backed candidate profile persistence (FR-012, SRS 5.2).
 *
 * The two things this boundary owes its callers:
 *
 *   - **Faithful mapping.** A preference the candidate never stated must come
 *     back as `null`/empty, never as a defaulted value, so the matcher can treat
 *     it as UNKNOWN (ENG-001). The salary preference is the subtle one: SRS 5.2
 *     names it as a single attribute, it is stored as four columns, and it maps
 *     back to `null` only in the all-absent combination documented on
 *     `toSalaryPreference`.
 *   - **Whole-profile saves.** `saveForUser` replaces the child rows rather than
 *     appending, so a re-seed cannot leave a stale skill behind (see the port).
 */
export class PrismaCandidateProfileRepository implements CandidateProfileRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listProfiles(): Promise<StoredCandidateProfile[]> {
    const rows = await this.prisma.candidateProfile.findMany({
      include: PROFILE_INCLUDE,
      // Deterministic order (createdAt then id): a caller that scores every
      // profile must get the same sequence on every run.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toStoredProfile);
  }

  async saveForUser(input: SaveCandidateProfileInput): Promise<StoredCandidateProfile> {
    const { profile } = input;
    const fields = {
      experienceYears: profile.experienceYears,
      remotePreference: profile.remotePreference as RemotePreference,
      relocationPreference: profile.relocationPreference as RelocationPreference,
      employmentPreferences: [...profile.employmentPreferences] as EmploymentType[],
      salaryMin: profile.salaryPreference?.min ?? null,
      salaryCurrency: profile.salaryPreference?.currency ?? null,
      salaryPeriod: (profile.salaryPreference?.period ?? null) as SalaryPeriod | null,
      salaryRequireDisclosed: profile.salaryPreference?.requireDisclosed ?? false,
      profileVersion: profileVersionOf(profile),
    };
    const children = {
      skills: {
        create: profile.skills.map((skill) => ({
          canonicalSkill: skill.canonicalSkill,
          skillType: skill.skillType as SkillEvidence,
          confidence: skill.confidence,
        })),
      },
      targetRoles: {
        create: profile.targetRoles.map((role) => ({
          title: role.title,
          aliases: [...role.aliases],
        })),
      },
      locationPreferences: {
        create: profile.locationPreferences.map((preference) => ({
          category: preference.category as LocationCategory,
          text: preference.text,
        })),
      },
    };

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.candidateProfile.findUnique({
        where: { userId: input.userId },
        select: { id: true },
      });

      if (existing === null) {
        return tx.candidateProfile.create({
          data: { userId: input.userId, ...fields, ...children },
          include: PROFILE_INCLUDE,
        });
      }

      // A save states the whole profile, so children are replaced, not merged.
      await tx.candidateSkill.deleteMany({ where: { candidateProfileId: existing.id } });
      await tx.targetRole.deleteMany({ where: { candidateProfileId: existing.id } });
      await tx.locationPreference.deleteMany({ where: { candidateProfileId: existing.id } });
      return tx.candidateProfile.update({
        where: { id: existing.id },
        data: { ...fields, ...children },
        include: PROFILE_INCLUDE,
      });
    });

    return toStoredProfile(row);
  }
}

function toStoredProfile(row: ProfileRow): StoredCandidateProfile {
  return {
    id: row.id,
    userId: row.userId,
    profileVersion: row.profileVersion,
    profile: {
      profileVersion: row.profileVersion,
      experienceYears: row.experienceYears,
      remotePreference: row.remotePreference as RemotePreference,
      relocationPreference: row.relocationPreference as RelocationPreference,
      salaryPreference: toSalaryPreference(row),
      employmentPreferences: row.employmentPreferences as EmploymentType[],
      skills: row.skills
        .map(toCandidateSkill)
        .sort((left, right) => left.canonicalSkill.localeCompare(right.canonicalSkill)),
      targetRoles: row.targetRoles
        .map(toTargetRole)
        .sort((left, right) => left.title.localeCompare(right.title)),
      locationPreferences: row.locationPreferences
        .map(toLocationPreference)
        .sort((left, right) =>
          `${left.category}:${left.text ?? ''}`.localeCompare(`${right.category}:${right.text ?? ''}`),
        ),
    },
  };
}

function toCandidateSkill(row: ProfileRow['skills'][number]): CandidateSkill {
  return {
    canonicalSkill: row.canonicalSkill,
    skillType: row.skillType as SkillEvidence,
    confidence: asProbability(Number(row.confidence)),
  };
}

function toTargetRole(row: ProfileRow['targetRoles'][number]): TargetRole {
  return { title: row.title, aliases: row.aliases };
}

function toLocationPreference(row: ProfileRow['locationPreferences'][number]): LocationPreference {
  return { category: row.category as LocationCategory, text: row.text };
}

/**
 * `null` exactly when the candidate stated no salary expectation at all: no
 * floor, no currency, no period, and no disclosure requirement. Every other
 * combination is a real (if partial) preference — `requireDisclosed` alone is
 * meaningful, and so is a currency with no minimum yet.
 */
function toSalaryPreference(row: ProfileRow): SalaryPreference | null {
  const min = row.salaryMin === null ? null : asDecimalAmount(row.salaryMin.toFixed(2));
  if (min === null && row.salaryCurrency === null && row.salaryPeriod === null && !row.salaryRequireDisclosed) {
    return null;
  }
  return {
    min,
    currency: row.salaryCurrency,
    period: row.salaryPeriod as SalaryPeriod | null,
    requireDisclosed: row.salaryRequireDisclosed,
  };
}
