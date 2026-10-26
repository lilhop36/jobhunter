-- FR-019: a capped run still has a coverage window — the range of publication dates it read.
-- An unobserved record published strictly after this floor was inside that window; records
-- at or before it may lie beyond the pages read. NULL means no window claim.
-- Additive and nullable, so every pre-existing run makes no claim (the safe direction: no
-- retirement) and the lifecycle sweep can treat it as unqualified.
ALTER TABLE "source_runs" ADD COLUMN "oldestListingPublishedAt" TIMESTAMP(3);
