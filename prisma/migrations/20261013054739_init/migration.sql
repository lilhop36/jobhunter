-- CreateEnum
CREATE TYPE "LifecycleStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REMOVED', 'NOT_FOUND');

-- CreateEnum
CREATE TYPE "CalendarType" AS ENUM ('GREGORIAN', 'ETHIOPIAN', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SalaryType" AS ENUM ('EXACT', 'RANGE', 'STARTING_FROM', 'UP_TO', 'NEGOTIABLE', 'NOT_DISCLOSED', 'AS_PER_SCALE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SalaryPeriod" AS ENUM ('HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LocationCategory" AS ENUM ('ADDIS_ABABA', 'ETHIOPIA_CITY', 'ETHIOPIA_REGION', 'ETHIOPIA_REMOTE', 'INTERNATIONAL_REMOTE', 'INTERNATIONAL_ON_SITE', 'HYBRID', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "EvidenceState" AS ENUM ('KNOWN', 'UNKNOWN', 'CONFLICTING');

-- CreateEnum
CREATE TYPE "SkillEvidence" AS ENUM ('EXACT_MATCH', 'CANONICAL_ALIAS', 'RELATED_SKILL', 'TRANSFERABLE', 'AI_SUGGESTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AIStatus" AS ENUM ('SUCCESS', 'TIMEOUT', 'UNAVAILABLE', 'INVALID_OUTPUT', 'SCHEMA_ERROR', 'PROVIDER_ERROR', 'FALLBACK');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApplicationMethod" AS ENUM ('ONLINE_URL', 'EMAIL', 'SOURCE_ACCOUNT', 'PDF_FORM', 'IN_PERSON', 'INSTRUCTIONS', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DescriptionQuality" AS ENUM ('SUFFICIENT', 'PARTIAL', 'UNUSABLE');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP', 'TEMPORARY', 'FREELANCE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RemoteStatus" AS ENUM ('ONSITE', 'REMOTE', 'HYBRID', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ProvenanceSource" AS ENUM ('SOURCE', 'DETERMINISTIC', 'AI');

-- CreateEnum
CREATE TYPE "HealthStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'FAILING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SourceRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "SourceRunTrigger" AS ENUM ('SCHEDULE', 'MANUAL', 'STARTUP');

-- CreateEnum
CREATE TYPE "WorkTaskStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER');

-- CreateTable
CREATE TABLE "job_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "adapterType" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "accessPolicy" JSONB,
    "schedule" TEXT,
    "healthStatus" "HealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastSuccessfulRunAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sourceId" UUID NOT NULL,
    "status" "SourceRunStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" "SourceRunTrigger" NOT NULL DEFAULT 'SCHEDULE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "jobsDiscovered" INTEGER NOT NULL DEFAULT 0,
    "jobsAccepted" INTEGER NOT NULL DEFAULT 0,
    "jobsDuplicate" INTEGER NOT NULL DEFAULT 0,
    "jobsRejected" INTEGER NOT NULL DEFAULT 0,
    "parseFailures" INTEGER NOT NULL DEFAULT 0,
    "httpFailures" INTEGER NOT NULL DEFAULT 0,
    "unexpectedZeroResults" BOOLEAN NOT NULL DEFAULT false,
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sourceId" UUID NOT NULL,
    "sourceRunId" UUID,
    "sourceJobIdentifier" TEXT,
    "sourceUrl" TEXT,
    "rawTitle" TEXT,
    "rawCompany" TEXT,
    "rawLocation" TEXT,
    "rawDescription" TEXT,
    "rawPublishedDateText" TEXT,
    "rawSalaryText" TEXT,
    "rawPayload" JSONB,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sourceId" UUID NOT NULL,
    "rawJobId" UUID,
    "canonicalUrl" TEXT,
    "title" TEXT,
    "company" TEXT,
    "description" TEXT,
    "descriptionQuality" "DescriptionQuality" NOT NULL,
    "locationText" TEXT,
    "locationCategory" "LocationCategory" NOT NULL DEFAULT 'UNKNOWN',
    "publishedCalendar" "CalendarType" NOT NULL DEFAULT 'UNKNOWN',
    "originalPublishedDateText" TEXT,
    "publishedAt" TIMESTAMP(3),
    "dateConfidence" DECIMAL(4,3),
    "salaryType" "SalaryType" NOT NULL DEFAULT 'UNKNOWN',
    "salaryMin" DECIMAL(14,2),
    "salaryMax" DECIMAL(14,2),
    "salaryCurrency" TEXT,
    "salaryPeriod" "SalaryPeriod" NOT NULL DEFAULT 'UNKNOWN',
    "salaryEvidence" TEXT,
    "salaryConfidence" DECIMAL(4,3),
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'UNKNOWN',
    "remoteStatus" "RemoteStatus" NOT NULL DEFAULT 'UNKNOWN',
    "applicationMethod" "ApplicationMethod" NOT NULL DEFAULT 'UNKNOWN',
    "applyUrl" TEXT,
    "applyEmail" TEXT,
    "lifecycleStatus" "LifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
    "contentFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "dedupeKey" TEXT,
    "status" "WorkTaskStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "sourceRunId" UUID,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "level" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_sources_name_key" ON "job_sources"("name");

-- CreateIndex
CREATE INDEX "source_runs_sourceId_startedAt_idx" ON "source_runs"("sourceId", "startedAt");

-- CreateIndex
CREATE INDEX "raw_jobs_sourceId_sourceJobIdentifier_idx" ON "raw_jobs"("sourceId", "sourceJobIdentifier");

-- CreateIndex
CREATE INDEX "raw_jobs_sourceRunId_idx" ON "raw_jobs"("sourceRunId");

-- CreateIndex
CREATE INDEX "jobs_canonicalUrl_idx" ON "jobs"("canonicalUrl");

-- CreateIndex
CREATE INDEX "jobs_contentFingerprint_idx" ON "jobs"("contentFingerprint");

-- CreateIndex
CREATE INDEX "jobs_sourceId_lifecycleStatus_idx" ON "jobs"("sourceId", "lifecycleStatus");

-- CreateIndex
CREATE INDEX "jobs_publishedAt_idx" ON "jobs"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "work_tasks_dedupeKey_key" ON "work_tasks"("dedupeKey");

-- CreateIndex
CREATE INDEX "work_tasks_status_runAfter_priority_idx" ON "work_tasks"("status", "runAfter", "priority");

-- CreateIndex
CREATE INDEX "work_tasks_leaseExpiresAt_idx" ON "work_tasks"("leaseExpiresAt");

-- CreateIndex
CREATE INDEX "system_logs_level_createdAt_idx" ON "system_logs"("level", "createdAt");

-- CreateIndex
CREATE INDEX "system_logs_area_createdAt_idx" ON "system_logs"("area", "createdAt");

-- AddForeignKey
ALTER TABLE "source_runs" ADD CONSTRAINT "source_runs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "job_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_jobs" ADD CONSTRAINT "raw_jobs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "job_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_jobs" ADD CONSTRAINT "raw_jobs_sourceRunId_fkey" FOREIGN KEY ("sourceRunId") REFERENCES "source_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "job_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_rawJobId_fkey" FOREIGN KEY ("rawJobId") REFERENCES "raw_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_tasks" ADD CONSTRAINT "work_tasks_sourceRunId_fkey" FOREIGN KEY ("sourceRunId") REFERENCES "source_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
