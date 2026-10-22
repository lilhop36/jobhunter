-- FR-019 (SRS 4.4 "detect expired ... jobs"): the application deadline a source stated.
-- Additive and non-destructive: every existing row keeps NULL, which means UNKNOWN - the
-- deadline was not stated, and it is never inferred from the posting's age.
-- Written by hand because this repo has no `prisma migrate dev` path; verified against the
-- Prisma schema with `prisma migrate diff`.

ALTER TABLE "jobs" ADD COLUMN "applicationDeadline" TIMESTAMP(3);

-- The deadline reconciliation scans for jobs whose stated deadline has passed, and the
-- notification dispatcher asks the same question per candidate row.
CREATE INDEX "jobs_applicationDeadline_idx" ON "jobs"("applicationDeadline");
