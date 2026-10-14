-- SRS 7.7 step 10 ("schedule enrichment/matching work").
--
-- The enrichment/matching stage has no registered handler yet, so the collection run
-- cannot enqueue that work without producing guaranteed permanent failures. It also must
-- not look as though the step happened. This column records, per run, whether the
-- downstream hand-off was scheduled, so a `SUCCEEDED` collection status never silently
-- implies that the required step 10 ran.
--
-- Engineering-owned observability, in the same class as the funnel counters
-- (`undeduplicable`, `fallbackIdentities`); the SRS fixes only
-- `SourceRun(sourceId, startedAt)`. `false` is truthful for every existing row and for
-- any run that does not schedule the work.
ALTER TABLE "source_runs"
  ADD COLUMN "enrichmentScheduled" BOOLEAN NOT NULL DEFAULT false;
