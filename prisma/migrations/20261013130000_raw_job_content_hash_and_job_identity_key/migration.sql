-- RawJob.contentHash, RawJob.lastSeenAt and Job.identityKey (ADR-0001).
--
-- Hand-written, not generated: it creates partial indexes Prisma cannot express, and
-- `prisma migrate dev` would drop the two pre-existing hand-written partial indexes
-- (`one_active_run_per_source`, `one_active_task_per_dedupe_key`).
--
-- No valid backfill exists for contentHash or identityKey: both depend on data that was
-- never recorded, and inventing values would fabricate identity. Fail loudly instead of
-- silently fabricating.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "raw_jobs") OR EXISTS (SELECT 1 FROM "jobs") THEN
    RAISE EXCEPTION 'raw_jobs/jobs are not empty: no valid backfill exists for contentHash/identityKey (ADR-0001)';
  END IF;
END $$;

-- Versioned SHA-256 of the captured raw fields, computed by the domain layer.
ALTER TABLE "raw_jobs" ADD COLUMN "contentHash" TEXT NOT NULL;
-- Last observed by the collection process. Never the source's content-update time.
ALTER TABLE "raw_jobs" ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- One capture per (source, source identifier, content hash): an identical re-capture is
-- a no-op and changed content is always a new row.
CREATE UNIQUE INDEX "one_raw_observation_per_identifier"
  ON "raw_jobs" ("sourceId", "sourceJobIdentifier", "contentHash")
  WHERE "sourceJobIdentifier" IS NOT NULL;

-- The same guarantee when the source supplies no stable identifier. A NULL identifier
-- cannot be covered by the index above, because PostgreSQL treats NULLs as distinct.
CREATE UNIQUE INDEX "one_raw_observation_per_content"
  ON "raw_jobs" ("sourceId", "contentHash")
  WHERE "sourceJobIdentifier" IS NULL;

-- Source-scoped source-record identity. NOT NULL because a Job exists only for a record
-- whose identity resolved; the plain (non-partial) unique index is what makes that
-- structural. A partial index over a nullable key would accept repeated NULLs and so
-- would not prevent identity-less Jobs from being promoted.
ALTER TABLE "jobs" ADD COLUMN "identityKey" TEXT NOT NULL;

CREATE UNIQUE INDEX "one_job_per_source_identity"
  ON "jobs" ("sourceId", "identityKey");
