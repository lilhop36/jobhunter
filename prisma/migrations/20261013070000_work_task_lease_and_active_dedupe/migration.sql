-- Work queue hardening:
--   * a per-claim lease token (stale-worker protection), and
--   * active-task deduplication via a partial unique index.
--
-- Prisma cannot express partial indexes, so this migration is hand-written and
-- must be preserved. The WHERE predicate lists exactly the WorkTaskStatus values
-- considered "active" (PENDING, RUNNING). Keep it in sync with
-- ACTIVE_WORK_TASK_STATUSES in src/domain/types/work-task.ts.

-- 1. Per-claim lease token. NULL for unclaimed/terminal-execution rows; unique
--    whenever present so two live claims can never share a token.
ALTER TABLE "work_tasks" ADD COLUMN "leaseToken" TEXT;
CREATE UNIQUE INDEX "work_tasks_leaseToken_key" ON "work_tasks"("leaseToken");

-- 2. Replace the unconditional dedupe uniqueness with active-only uniqueness so a
--    terminal task no longer blocks a fresh, equivalent task from being queued.
DROP INDEX "work_tasks_dedupeKey_key";
CREATE UNIQUE INDEX "one_active_task_per_dedupe_key"
  ON "work_tasks" ("dedupeKey")
  WHERE "status" IN ('PENDING', 'RUNNING') AND "dedupeKey" IS NOT NULL;
