-- Audit M6: the Ethiojobs adapter declared the whole posting slug as its stable identifier, but a
-- slug is `<id>-<title text>` and the title is the publisher's to edit. The adapter now declares the
-- leading id segment, so rows captured before the fix have to move to the same basis.
--
-- Without this rename the next collection resolves a *different* identity for every Ethiojobs
-- posting: `sid:` outranks the canonical URL, so it would create a duplicate Job and leave the
-- original - with its match and notification history - to be retired by the lifecycle sweep.
--
-- Forward-only, and it changes no captured payload: raw evidence stays append-only, only the
-- identifier it is filed under moves. PostgreSQL runs each migration in one transaction, so a
-- collision aborts the whole rename rather than half-applying it.

-- A clear refusal beats a unique-index violation in the middle of the rename.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "jobs" j
    JOIN "job_sources" s ON s.id = j."sourceId"
    WHERE s."adapterType" = 'ETHIOJOBS_STATIC_HTML'
      AND j."identityKey" LIKE 'sid:%'
      AND position('-' in substring(j."identityKey" from 5)) > 1
    GROUP BY split_part(substring(j."identityKey" from 5), '-', 1)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Ethiojobs id-segment rename collides on % posting(s); refusing to rename',
      (SELECT count(*) FROM "jobs" j JOIN "job_sources" s ON s.id = j."sourceId"
        WHERE s."adapterType" = 'ETHIOJOBS_STATIC_HTML' AND j."identityKey" LIKE 'sid:%');
  END IF;
END $$;

-- `position(...) > 1` is the SQL form of the adapter's rule (the separator must not be the first
-- character), so a slug with no separator is left exactly as it is - and after the rename no value
-- still has a separator at that position, which makes this migration safe to run twice.
UPDATE "jobs" j
  SET "identityKey" = 'sid:' || split_part(substring(j."identityKey" from 5), '-', 1)
  FROM "job_sources" s
 WHERE s.id = j."sourceId"
   AND s."adapterType" = 'ETHIOJOBS_STATIC_HTML'
   AND j."identityKey" LIKE 'sid:%'
   AND position('-' in substring(j."identityKey" from 5)) > 1;

UPDATE "raw_jobs" r
  SET "sourceJobIdentifier" = split_part(r."sourceJobIdentifier", '-', 1)
  FROM "job_sources" s
 WHERE s.id = r."sourceId"
   AND s."adapterType" = 'ETHIOJOBS_STATIC_HTML'
   AND r."sourceJobIdentifier" IS NOT NULL
   AND position('-' in r."sourceJobIdentifier") > 1;
