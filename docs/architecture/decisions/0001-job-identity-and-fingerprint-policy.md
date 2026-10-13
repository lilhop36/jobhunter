# ADR-0001: Job identity, content fingerprints, and duplicate handling

- **Status:** Proposed — awaiting owner/reviewer sign-off
- **Date:** 2026-10-13
- **Relates to:** SRS v1.1 §5.2, §5.3, §5.4, §5.6, §7.7, §7.8; ENG-002, ENG-005, ENG-025
- **Blocks:** the collection slice (`RawJob`/`Job` persistence, `RunSourceCollection`)

## Why this decision needs its own record

A unique index is a statement about reality. If it claims two source records are the
same job when they are not, the second is **silently discarded** — no error, no log,
and the funnel reports it as a duplicate that was correctly deduplicated. That loss is
hard to detect and hard to repair. This ADR therefore fixes the identity rules before
any uniqueness constraint exists, and states explicitly what is *not* claimed.

## Decision

Three different questions get three different mechanisms. They must never share one
index.

| # | Concept | Column | Scope | Uniqueness |
|---|---------|--------|-------|------------|
| 1 | **Source-record identity** — "this is the same posting on this source" | `RawJob.sourceJobIdentifier` (source-provided) and `Job.identityKey` (resolved) | per source | unique within the source |
| 2 | **Content equality** — "this is byte-equivalent captured content" | `RawJob.contentHash`; `Job.contentFingerprint` | per source | indexed for lookup, **not** unique |
| 3 | **Canonical job identity** — "these records describe the same real job across sources" | *(none yet)* | global | **deferred**, see below |

Concept 3 is deliberately not implemented. ENG-005 (the cross-source merge) is
deferred, and merging two records requires a policy that justifies the merge. Until
such a policy exists, `Job.identityKey` is **not** a cross-source canonical identity
and must not be treated as one.

## 1. Source-record identity

Resolution order, evaluated once per record by the pipeline and recorded on the `Job`:

| Order | Condition | `identityKey` value |
|-------|-----------|--------------------|
| 1 | The adapter declares `sourceJobIdentifier` stable | `sid:<identifier>` |
| 2 | No stable identifier, and the adapter declares the canonical URL trustworthy | `url:<canonicalUrl>` |
| 3 | Neither, but the record has usable title/company/location text | `fp:<fallback fingerprint>` |
| 4 | Neither, and no usable text | `NULL` — **undeduplicable** |

The `sid:` / `url:` / `fp:` prefix makes the basis of every key visible, so a URL can
never collide with a source-provided identifier, and the weakest basis (`fp:`) is
identifiable by inspection rather than assumed equivalent to a real identifier.

**The adapter declares stability, the pipeline does not guess it.** A source may
supply an identifier that is not stable (a view counter, a per-request token). Only an
adapter that has verified the field may set it, and that verification belongs in the
source approval record.

### Limitation of the `fp:` fallback

The `fp:` fallback is a **deduplication convenience, not proof of identity**:

- Two genuinely distinct postings with the same normalized title, company and location
  will collide and one will be discarded.
- An edited posting that changes any fallback input produces a new `identityKey`, so it
  becomes a second Job instead of an update.

Both errors are accepted only for sources that provide no stable identifier and no
trustworthy URL. The funnel counts records resolved this way so the affected volume is
always visible, and `docs`/the source approval record must state the limitation for any
source in that class. A source in that class is a candidate for re-review, not a
permanent state.

### Degenerate records

A record with `identityKey = NULL` is stored as raw evidence for reprocessing, counted
as `undeduplicable`, and **not** promoted to a `Job`. A Job with no identity cannot be
deduplicated and would be duplicated on every rerun, which is worse than not promoting
it: the evidence is preserved, and nothing is claimed that cannot be defended.

## 2. Content fingerprints

Two fingerprints at two levels. Both are versioned; both are lookup keys only.

| Hash | Input | Purpose |
|------|-------|---------|
| `RawJob.contentHash` | the captured raw fields | detect that a capture is byte-equivalent to one already stored (ENG-002) |
| `Job.contentFingerprint` | the normalized job fields | §5.2 attribute; supports duplicate *signals* and auditing |

`Job.contentFingerprint` **includes the description**; `Job.identityKey` does **not**.
Descriptions are edited in place, and an edited posting must not become a new job.

### Fingerprint v1

- **Version tag:** every value is prefixed `v1:<kind>:` where `kind` is `raw`,
  `content` or `identity`. A future change to inputs, normalization or algorithm bumps
  the version, so old and new values are never compared as if equivalent and a
  re-fingerprint can be targeted by version. The `kind` segment means the three
  fingerprints answering different questions cannot collide with each other either.
  Example: `v1:content:9f2c…`.
- **Algorithm:** SHA-256 over a UTF-8 encoded string, hex-encoded. Deliberately not a
  short non-cryptographic hash: the previous `contentFingerprint` was a 32-bit
  Java-style `String.hashCode`, which collides with ~50% probability by roughly 77k
  distinct values. Used as a uniqueness key that is silent data loss.
- **Normalization (applied to every field):** Unicode NFKC; `\r\n` and `\r` → `\n`;
  all whitespace runs collapsed to a single space; trimmed; lowercased.
- **Encoding:** each present field is emitted as a **length-prefixed, tagged** segment
  (`<tag><length>:<value>`) and segments are joined with `\u0000`. This makes field
  boundaries unambiguous — `("Acme Corp", "Ltd")` and `("Acme", "Corp Ltd")` no longer
  produce the same input string — and, because the segment is self-delimiting, a
  captured value cannot forge a boundary even if it literally contains a tag name, `=`
  or the separator. Captured text is untrusted input, so "the separator will not occur
  in practice" is not an assumption this code may make. A **missing** field is also
  distinguishable from an **empty** one: a missing field emits no segment, an empty
  field emits a zero-length segment.
- **Tags:** raw level `t` title, `c` company, `l` location, `d` description, `s` salary
  text, `p` published-date text, `u` url. Job level `t` title, `c` company, `l`
  locationText, `d` description, `u` canonicalUrl.
- **Ordering:** fixed by tag, never by input order.
- **No volatile fields:** no collection timestamp, view counts, relative-age text or
  run id, so the same posting fingerprints identically on every collection.

## 3. Persistence and conflict handling

`ON CONFLICT` targets must match their partial index predicate **exactly**; Prisma's
`upsert` cannot target a partial index, so these are hand-written.

### RawJob — append-only evidence

```sql
CREATE UNIQUE INDEX "one_raw_observation_per_identifier"
  ON "raw_jobs" ("sourceId", "sourceJobIdentifier", "contentHash")
  WHERE "sourceJobIdentifier" IS NOT NULL;

CREATE UNIQUE INDEX "one_raw_observation_per_content"
  ON "raw_jobs" ("sourceId", "contentHash")
  WHERE "sourceJobIdentifier" IS NULL;

-- identical capture seen again: no new row, but record that we saw it
INSERT INTO "raw_jobs" (...)
VALUES (...)
ON CONFLICT ("sourceId", "sourceJobIdentifier", "contentHash")
  WHERE "sourceJobIdentifier" IS NOT NULL
DO NOTHING
RETURNING ...;
-- when no row is returned, the observation already exists:
UPDATE "raw_jobs" SET "lastSeenAt" = <now_utc>
WHERE "sourceId" = $1 AND "sourceJobIdentifier" = $2 AND "contentHash" = $3;
```

| Case | Result |
|------|--------|
| Identical content re-observed | no new row, `lastSeenAt` advanced |
| Changed content, same source record | **new** RawJob row; the earlier capture is untouched |
| First observation | new row, `createdAt = lastSeenAt` |

`lastSeenAt` is the only column a re-observation writes. It is observation metadata
owned by the collection stage, not captured evidence, so this does not mutate source
evidence and is consistent with ENG-002 ("never deleted or mutated by *downstream*
stages"). No captured field is ever overwritten.

### Job — current state, one per source record

```sql
CREATE UNIQUE INDEX "one_job_per_source_identity"
  ON "jobs" ("sourceId", "identityKey")
  WHERE "identityKey" IS NOT NULL;

INSERT INTO "jobs" (...) VALUES (...)
ON CONFLICT ("sourceId", "identityKey")
  WHERE "identityKey" IS NOT NULL
DO UPDATE SET
  "rawJobId" = EXCLUDED."rawJobId",   -- latest evidence version
  "title" = EXCLUDED."title",         -- refreshed normalized fields
  ...,
  "updatedAt" = <now_utc>
RETURNING ...;
```

Changed content therefore **updates** the existing Job and repoints `rawJobId` at the
new evidence row; it does not create a second Job. Because the index includes
`sourceId`, two sources producing the same key stay separate — no silent cross-source
merge.

`Job(canonicalUrl)` and `Job(contentFingerprint)` remain **plain** indexes (§5.6).
`canonicalUrl` is a duplicate *signal*, never a key: one generic careers URL can
legitimately front many distinct postings.

## 4. Zero-result runs

A run that completes with zero results is `SUCCEEDED` by default. It becomes
`PARTIAL` with `unexpectedZeroResults = true`, a specific `errorSummary`, and an
observable health signal **only when an explicit source expectation says zero is
unexpected**:

```
unexpectedZeroResults =
    collected == 0
    AND source normally yields results        (documented expectation / recent health)
```

The expectation is a per-source policy input, not a global assumption: an empty result
from a source that is genuinely quiet is legitimate and must not be reported as
unhealthy. Until a source has a recorded expectation, `collected == 0` is recorded as
`SUCCEEDED` with the zero visible in the funnel, and no health signal is raised —
"unknown expectation" is not evidence of breakage.

## 5. New attributes requiring an SRS §5.2 update

These are additive and follow the same process used for `Job.provenance`. **The SRS is
not edited here**; the owner adds the lines.

| Attribute | Table | Why §5.2 does not already cover it |
|-----------|-------|------------------------------------|
| `contentHash` | `RawJob` | §5.2 lists no content hash; without one, "identical rerun" and "edited posting" cannot be told apart, so idempotency and ENG-002 cannot both hold |
| `lastSeenAt` | `RawJob` | §5.2 lists only `collectedAt`; there is no way to distinguish a stale record from a recently observed one |
| `identityKey` | `Job` | §5.2 lists `contentFingerprint` (content equality) but no source-record identity, so "update the Job on edit" is not representable |

## 6. What this policy explicitly does not do

- No unique constraint on `Job.identityKey` across sources; ENG-005 is deferred.
- No merge of records because their titles (or any single field) match.
- No deletion or overwrite of captured evidence.
- No assumption that a content hash proves two postings are the same job.
- No global unique `contentFingerprint`; it stays a lookup index.
- No adapter implements any of this until the source approval record is signed.

## 7. Open questions for review

1. `Job.identityKey` is defined here as the **source-scoped source-record identity**
   (concept 1 applied to the Job). It is intentionally *not* the cross-source canonical
   identity, which is deferred. Confirm, or specify that concept 1 and 3 need separate
   columns now.
2. Degenerate records (`identityKey = NULL`) are stored as evidence but not promoted to
   a Job. Confirm.
3. Fallback order places a trustworthy canonical URL **ahead of** the content fallback
   fingerprint, but the reviewer's note also warns against canonical-URL-based
   uniqueness. The URL is used only when the adapter declares it trustworthy, and never
   as the sole cross-source signal. Confirm.
4. `lastSeenAt` is advanced by the collection stage on re-observation, which is the only
   write a re-observation performs. Confirm this reading of ENG-002.

## 8. Verification obligations

- Duplicate ingestion: a rerun of identical content creates no new RawJob and no new Job.
- Legitimate changed content: a rerun with edited content creates one new RawJob and
  **updates** the existing Job (no second Job).
- Field-boundary ambiguity and missing-vs-empty are covered by unit tests on the
  fingerprint.
- Distinct sources with identical content stay separate Jobs.
- Undeduplicable records are counted and never promoted.
- A hand-written-index guard test covers each new partial index by name and predicate.
