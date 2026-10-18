-- SRS 5.2 JobMatch and 5.6 "Recommended indexes"; FR-013, FR-014, FR-015;
-- Milestone 2 (ADR-0005). Written by hand because this repo has no
-- `prisma migrate dev` path; verified against the Prisma schema with
-- `prisma migrate diff` (see the repository integration test).
--
-- `profileVersion` and `inputHash` are engineering additions to the SRS 5.2
-- attribute list and are reported as such (see ADR-0005 and the Phase 3 report).
-- `scoredAt` is separate from `createdAt` because the injected clock is not part
-- of `inputHash` (SRS 4.6 freshness): a freshness-only re-score updates the row
-- in place instead of inventing new inputs.

CREATE TABLE "job_matches" (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  score INTEGER NOT NULL,
  confidence INTEGER NOT NULL,
  "roleScore" INTEGER,
  "skillScore" INTEGER,
  "experienceScore" INTEGER,
  "locationScore" INTEGER,
  "employmentScore" INTEGER,
  "freshnessScore" INTEGER,
  "salaryScore" INTEGER,
  evidence JSONB NOT NULL,
  explanation TEXT NOT NULL,
  "matcherVersion" TEXT NOT NULL,
  "profileVersion" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "scoredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "job_matches_pkey" PRIMARY KEY ("id")
);

-- One row per distinct (user, job, matcherVersion, canonical input set). SRS 5.6
-- lists JobMatch(userId, jobId) UNIQUE; the hash and matcherVersion extend it so a
-- profile edit or a changed job produces a new row instead of overwriting history.
CREATE UNIQUE INDEX "one_match_per_user_job_input"
  ON "job_matches"("userId", "jobId", "matcherVersion", "inputHash");

-- SRS 5.6 "Recommended indexes": JobMatch(userId, score).
CREATE INDEX "job_matches_userId_score_idx" ON "job_matches"("userId", score);

ALTER TABLE "job_matches"
  ADD CONSTRAINT "job_matches_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "job_matches"
  ADD CONSTRAINT "job_matches_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
