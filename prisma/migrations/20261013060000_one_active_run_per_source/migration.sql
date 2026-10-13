-- Source exclusivity: at most one RUNNING SourceRun per source (SRS 5.3 / FR-003 / 7.5).
-- This partial unique index cannot be expressed in schema.prisma, so it is
-- maintained as hand-written SQL. If the index is ever dropped by a generated
-- migration, DB-level source exclusivity is lost and the manual-run endpoint
-- can no longer rely on the 409 `SOURCE_RUN_ACTIVE` guarantee.
CREATE UNIQUE INDEX "one_active_run_per_source"
  ON "source_runs" ("sourceId")
  WHERE "status" = 'RUNNING';
