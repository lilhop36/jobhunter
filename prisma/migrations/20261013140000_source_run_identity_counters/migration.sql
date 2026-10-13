-- Engineering-owned observability counters on `source_runs` (ADR-0001 section 4).
--
-- `SourceRun` is engineering-owned: the SRS data model fixes only
-- `SourceRun(sourceId, startedAt)`, so these are additive engineering counters in the same
-- class as the ones already on the table. They are NOT SRS 5.2 attributes and the SRS is
-- not edited for them.
--
-- `undeduplicable`   - records preserved as raw evidence but not promoted to a Job because
--                      no identity resolved. Without it the SRS 7.8 funnel arithmetic
--                      (`parsed = unique + jobsDuplicate + jobsRejected + undeduplicable`)
--                      does not close.
-- `fallbackIdentities` - records whose identity rests on the weakest (`fp:`) basis, so the
--                      volume depending on that basis stays visible (ADR-0001 section 1).
--
-- Additive and safe for existing rows: a run recorded before this migration genuinely had
-- no such counts, so DEFAULT 0 is the truthful value rather than an invented backfill.

ALTER TABLE "source_runs"
  ADD COLUMN "undeduplicable" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fallbackIdentities" INTEGER NOT NULL DEFAULT 0;
