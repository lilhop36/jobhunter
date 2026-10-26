-- ENG-022 requires a timezone-aware type for new timestamp columns, and this one was first
-- added as a naive `timestamp(3)`. The floor holds UTC-midnight publication dates, so `USING`
-- reinterprets the stored wall clock as UTC; without it PostgreSQL would read the existing
-- values in the session's TimeZone and shift them.
ALTER TABLE "source_runs"
  ALTER COLUMN "oldestListingPublishedAt" TYPE timestamptz(3)
  USING "oldestListingPublishedAt" AT TIME ZONE 'UTC';
