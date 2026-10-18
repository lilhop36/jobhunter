-- SRS 4.5, 5.2 (CandidateProfile, CandidateSkill, TargetRole, LocationPreference, User);
-- FR-012; Milestone 2 ("Seeded candidate"). See ADR-0005 for the value sets the SRS
-- leaves open, and the Prisma models for every NULL/empty-is-UNKNOWN convention.

CREATE TYPE "RemotePreference" AS ENUM (
  'REMOTE_REQUIRED',
  'REMOTE_PREFERRED',
  'NO_PREFERENCE',
  'ONSITE_ONLY'
);

CREATE TYPE "RelocationPreference" AS ENUM (
  'WILLING',
  'NOT_WILLING',
  'UNDECIDED'
);

-- SRS 5.2 User. `role`/`status` are engineering-owned strings with v1 defaults
-- (Appendix A defines no value set); `passwordHash` is omitted because the SRS makes it
-- conditional on password auth and the v1 interface is Telegram linking.
CREATE TABLE "users" (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'OWNER',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE TABLE "candidate_profiles" (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "experienceYears" INTEGER,
  "remotePreference" "RemotePreference" NOT NULL,
  "relocationPreference" "RelocationPreference" NOT NULL,
  "employmentPreferences" "EmploymentType"[],
  "salaryMin" DECIMAL(14,2),
  "salaryCurrency" TEXT,
  "salaryPeriod" "SalaryPeriod",
  "salaryRequireDisclosed" BOOLEAN NOT NULL DEFAULT false,
  -- Derived from the profile content via profileVersionOf (src/domain/matching/profile-version).
  "profileVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "candidate_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "candidate_profiles_userId_key" ON "candidate_profiles"("userId");

-- SRS 5.2 CandidateSkill: canonicalSkill UNIQUE per profile (5.6 "Recommended indexes").
CREATE TABLE "candidate_skills" (
  "candidateProfileId" UUID NOT NULL,
  "canonicalSkill" TEXT NOT NULL,
  "skillType" "SkillEvidence" NOT NULL,
  "confidence" DECIMAL(4,3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  id UUID NOT NULL DEFAULT gen_random_uuid(),

  CONSTRAINT "candidate_skills_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "one_candidate_skill_per_profile" UNIQUE ("candidateProfileId", "canonicalSkill")
);

CREATE TABLE "target_roles" (
  "candidateProfileId" UUID NOT NULL,
  title TEXT NOT NULL,
  aliases TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  id UUID NOT NULL DEFAULT gen_random_uuid(),

  CONSTRAINT "target_roles_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "one_target_role_per_profile" UNIQUE ("candidateProfileId", "title")
);

CREATE TABLE "location_preferences" (
  "candidateProfileId" UUID NOT NULL,
  "category" "LocationCategory" NOT NULL,
  text TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  id UUID NOT NULL DEFAULT gen_random_uuid(),

  CONSTRAINT "location_preferences_pkey" PRIMARY KEY ("id"),

  -- NULLs count as distinct in PostgreSQL, so a total (profile, category, text)
  -- constraint is not expressible this way; the seed validates the set.
  CONSTRAINT "one_location_preference_per_profile" UNIQUE ("candidateProfileId", "category", "text")
);

ALTER TABLE "candidate_profiles"
  ADD CONSTRAINT "candidate_profiles_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "candidate_skills"
  ADD CONSTRAINT "candidate_skills_candidateProfileId_fkey"
  FOREIGN KEY ("candidateProfileId") REFERENCES "candidate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "target_roles"
  ADD CONSTRAINT "target_roles_candidateProfileId_fkey"
  FOREIGN KEY ("candidateProfileId") REFERENCES "candidate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "location_preferences"
  ADD CONSTRAINT "location_preferences_candidateProfileId_fkey"
  FOREIGN KEY ("candidateProfileId") REFERENCES "candidate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
