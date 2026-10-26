-- FR-019 prerequisite: a run records whether it read its source's listing to the end.
-- Only such runs may qualify the lifecycle sweep; the default false keeps every
-- pre-existing run unqualified, which is the safe direction (no retirement).
ALTER TABLE "source_runs" ADD COLUMN "catalogueExhausted" BOOLEAN NOT NULL DEFAULT false;
