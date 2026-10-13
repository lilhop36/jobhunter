# ADR-0001: Job identity, content fingerprints, and duplicate handling

- **Status:** Approved by the reviewer on 2026-10-13; implemented in increments (schema, repositories, URL-trust declaration, identity resolver, collection pipeline)
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

### URL trust is declared, not inferred

The `url:` basis (order 2) is gated on an explicit declaration —
`SourceAdapterConfig.canonicalUrlIdentityTrusted` — supplied from the source approval
record. A `sourceUrl` is present on most records and is frequently *not* identity-worthy:
a shared careers URL or a paginated listing page would collapse many distinct postings
into one identity and silently discard all but the first. The pipeline therefore does not
assume URL trust, and the field is **required with no default**, so a source cannot
inherit trust it never verified.

There is deliberately **no** matching "identifier is stable" flag: the
`RawJobEvidence.sourceJobIdentifier` contract already *is* that declaration ("Stable
identifier assigned by the source"), so an adapter that cannot verify stability leaves
the field `null`. URL trust needs its own flag because the URL field is routinely present
without being identity-worthy.

### URL canonicalisation for identity

`urlIdentityValue` (`src/domain/normalizers/url-normalizer.ts`) prepares the URL basis. It
delegates to `canonicalizeUrl` so the identity and the stored `Job.canonicalUrl` agree,
then applies the two rules identity needs on top.

| Aspect | Handling |
|--------|----------|
| scheme | must resolve to `http`/`https`. A value carrying a non-HTTP `scheme://`, or an opaque scheme (`mailto:`, `tel:`, `data:`), is rejected rather than rewritten into HTTPS. A schemeless value or `//host/...` is resolved by `canonicalizeUrl` — that is how relative links in scraped HTML are handled |
| host | lower-cased |
| port | preserved |
| path | case preserved; only a trailing slash is removed. The path is never rewritten |
| query | preserved, except the tracking parameters `canonicalizeUrl` already removes (`utm_*`, `gclid`, `fbclid`); that removal is documented in that function |
| fragment | removed — `#apply` is client-side navigation, not a different resource, so keeping it would fork one posting's identity |
| missing / blank | rejected (`null`) |
| malformed / unparseable | rejected (`null`) |
| bare host / site root | rejected — it addresses no resource, so every posting reachable from it would otherwise share one identity |
| redirects | **never resolved.** Resolving one needs a network call, and identity resolution is a pure function (ENG-012). A source whose job URLs redirect must be declared untrustworthy, or have its URLs canonicalised by the adapter |
| listing / pagination URLs | **not detected here.** Recognising them needs source-specific knowledge, and guessing would put source assumptions into shared domain code (ENG-016). `canonicalUrlIdentityTrusted` is the declaration that a source's URLs are job-detail URLs; this function enforces only what is provable from the URL alone |
| a changed URL for the same posting | yields a different `url:` key. This is why the URL basis is weaker than a stable identifier, and why trust must be declared |

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

**Minimum evidence.** The fallback fires only on evidence that can distinguish one posting
from another: a real **title** plus at least one other real field (company or location).
One field is not a discriminator — every "Software Engineer" on a source would collide
into a single posting and the rest would be silently discarded — and a title-less pair
names an employer/location group rather than a posting. When the evidence cannot
distinguish records the resolver returns `NULL` (undeduplicable) rather than guessing.

**Placeholder text** (`n/a`, `none`, `unknown`, `-`, `tbd`, …) is treated as **absent** in
the identity path, because a shared placeholder cannot distinguish employers: "Engineer @
N/A" at two employers would otherwise look like one posting. The list holds only
unambiguously non-values, and it applies to identity only — the content fingerprints still
keep placeholder text, because it was really collected.

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
evidence. ENG-002 reads, verbatim: *"Raw source evidence is preserved. Every accepted
Job traces to a RawJob, and a RawJob is never deleted or mutated by downstream stages."*
The constraint is on **downstream** stages; collection is the stage that produces the
RawJob, and `lastSeenAt` records *last observed by the collection process*, never a
claim about when the source changed the posting. No captured field is ever overwritten.

`contentHash` and `lastSeenAt` are NOT NULL. Every capture yields a hash (the hash of
empty content is still a valid, deterministic value), and every row has an observation
time.

### RawJob insert paths

The insert has **two mutually exclusive statements**, because a partial unique index is
only inferred by an `ON CONFLICT` whose predicate it can satisfy. The repository picks
the statement by whether the resolved identifier is present — never a single statement
with a fallback predicate:

| Record | Index used | Conflict target |
|--------|-----------|-----------------|
| Has a source identifier | `one_raw_observation_per_identifier` | `("sourceId","sourceJobIdentifier","contentHash") WHERE "sourceJobIdentifier" IS NOT NULL` |
| No identifier | `one_raw_observation_per_content` | `("sourceId","contentHash") WHERE "sourceJobIdentifier" IS NULL` |

An identifier-bearing record and a no-identifier record with the same content are
**not** deduplicated against each other; they are different observation paths. This is
a documented limitation, not an accident.

### Job — current state, one per source record

`identityKey` is **NOT NULL**: a Job is only ever created from a record whose identity
resolved (see *Degenerate records* above), so the constraint makes the policy structural
rather than conventional — an identity-less Job cannot be inserted at all. Because
`identityKey` is always present, the index is a **plain** unique index, not a partial one.

```sql
ALTER TABLE "jobs" ADD COLUMN "identityKey" text NOT NULL;

CREATE UNIQUE INDEX "one_job_per_source_identity"
  ON "jobs" ("sourceId", "identityKey");

INSERT INTO "jobs" (...) VALUES (...)
ON CONFLICT ("sourceId", "identityKey")
DO UPDATE SET
  "rawJobId" = EXCLUDED."rawJobId",   -- latest evidence version
  "title" = EXCLUDED."title",         -- refreshed normalized fields
  ...,
  "updatedAt" = <now_utc>
RETURNING ...;
```

The partial-index alternative was tested and rejected on evidence: a unique index
`ON ("sourceId","identityKey") WHERE "identityKey" IS NOT NULL` accepts two NULL rows in
the same source (PostgreSQL treats NULLs as distinct), so it would **not** prevent
accidental promotion of identity-less Jobs. It was also unnecessary once the column is
NOT NULL. See §8.

Changed content therefore **updates** the existing Job and repoints `rawJobId` at the
new evidence row; it does not create a second Job. The earlier capture is retained and
is still reachable via `raw_jobs` by `(sourceId, sourceJobIdentifier)` ordered by
`collectedAt`, so the Job's history remains reconstructable even though the FK points at
the current version only. Because the index includes `sourceId`, two sources producing
the same key stay separate — no silent cross-source merge.

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

The expectation is modelled explicitly as `SourceResultExpectation`
(`UNKNOWN | RESULTS_EXPECTED | ZERO_EXPECTED`) and passed to the collection use case.
`UNKNOWN` is the default and never raises the signal; only `RESULTS_EXPECTED` can. Where
the value is *stored* (a `JobSource` column versus the approval document) remains the
residual question in §7, so it is an explicit input rather than an invented column.

### Recording the funnel

§7.8 defines the funnel `collected → parsed → valid → unique → active → matched →
notified`; a run owns everything up to and including deduplication. Those stages are
already persisted or derivable — `collected` = `jobsDiscovered`, `parsed` =
`jobsDiscovered - parseFailures`, `valid` excludes `jobsRejected`, `unique` =
`jobsAccepted` — so the funnel itself needs no new column. Two *outcomes* do, because
they are not derivable from any other counter:

| Column | Why it is needed |
|--------|------------------|
| `undeduplicable` | a record that resolved no identity is preserved but belongs to no Job; without the count the funnel arithmetic (`collected = parsed + parseFailures`, `parsed = unique + jobsDuplicate + jobsRejected + undeduplicable`) does not close |
| `fallbackIdentities` | the volume resting on the weakest (`fp:`) basis must stay visible, per the §1 limitation |

Both are `INTEGER NOT NULL DEFAULT 0` on `source_runs`. `SourceRun` is **engineering-owned**
— the SRS data model fixes only `SourceRun(sourceId, startedAt)` — so these are additive
engineering observability, in the same class as the counters already there, and are **not**
§5.2 attributes. `jobsRejected` stays `0` for now: the SRS defines no collection-time
rejection rule, and Appendix E is explicit that a Job with `UNUSABLE` description quality
is *persisted* "for traceability and funnel metrics", so collection must not discard it.

## 5. New attributes requiring an SRS §5.2 update

These are additive and follow the same process used for `Job.provenance`. **The SRS is
not edited here**; the owner adds the lines.

| Attribute | Table | Nullability | Why §5.2 does not already cover it |
|-----------|-------|-------------|------------------------------------|
| `contentHash` | `RawJob` | NOT NULL | §5.2 lists no content hash; without one, "identical rerun" and "edited posting" cannot be told apart, so idempotency and ENG-002 cannot both hold |
| `lastSeenAt` | `RawJob` | NOT NULL | §5.2 lists only `collectedAt`; there is no way to distinguish a stale record from a recently observed one |
| `identityKey` | `Job` | NOT NULL | §5.2 lists `contentFingerprint` (content equality) but no source-record identity, so "update the Job on edit" is not representable |

Because all three are NOT NULL, the migration must be explicit about existing rows.
`raw_jobs` and `jobs` have no production data and no writer yet, but there is also **no
valid backfill**: `identityKey` and `contentHash` depend on data that was never recorded,
so inventing values would fabricate identity and violate the data-quality rule. The
migration therefore adds the columns directly and carries an **emptiness guard** that
raises if either table already contains rows, so it fails loudly rather than silently
fabricating identity for existing records.

## 6. What this policy explicitly does not do

- No unique constraint on `Job.identityKey` across sources; ENG-005 is deferred.
- No merge of records because their titles (or any single field) match.
- No deletion or overwrite of captured evidence.
- No assumption that a content hash proves two postings are the same job.
- No global unique `contentFingerprint`; it stays a lookup index.
- No automatic detection of listing or pagination URLs: that needs source knowledge and is
  a declaration, not a guess (§1).
- No adapter implements any of this until the source approval record is signed.

## 7. Sign-off

Approved by the reviewer on 2026-10-13. The four questions raised in the first draft are
resolved:

1. **`Job.identityKey` scope — approved.** Source-scoped for the MVP. Cross-source
   canonical identity is deferred with ENG-005. No merging across sources based on title,
   company or location. The one condition attached: a source-scoped key must not become a
   cross-source identity by accident. It cannot here — the index includes `sourceId`, so
   the same key in two sources is two Jobs and nothing ever unions them.
2. **Degenerate records — approved.** Stored as evidence, counted `undeduplicable`, not
   promoted. Enforced structurally by `identityKey NOT NULL`.
3. **`RawJob.lastSeenAt` — approved provisionally.** Means *last observed by the
   collection process*, explicitly not when the source last changed the posting. The
   exact ENG-002 wording is quoted in §3 (constraint is on *downstream* stages).
4. **Unknown source expectations — approved.** No unexpected-zero-results signal while a
   source's expected behaviour is unknown; the outcome is still recorded and observable.
   The expectation is defined explicitly in the source approval record.

Residual, to be settled when the first real adapter is approved: how a source's expected
result behaviour is recorded (a value on `JobSource` versus the approval document), and
which observable signal carries an unexpected zero.

## 8. Verification

### Pre-implementation probe (executed, real PostgreSQL 16, scratch schema)

The exact DDL and statements above were run against the test database in a throwaway
schema before being proposed. 16 checks, all passing:

| Check | Result |
|-------|--------|
| First observation inserts exactly one row | pass |
| Identical rerun inserts nothing | pass |
| Re-observation advances `lastSeenAt` without adding a row | pass |
| Changed content inserts a second capture, first one preserved | pass |
| Null-identifier record lands via the second index, rerun deduped | pass |
| Changed content updates the **same** Job and repoints `rawJobId` | pass |
| Job count stays 1 across a content change | pass |
| Both raw captures retained (evidence preserved) | pass |
| Same `identityKey` in a different source stays a separate Job | pass |
| `identityKey NOT NULL` rejects an identity-less Job | pass |
| A **partial** index on a nullable key does *not* prevent that promotion | pass (rejected alternative) |
| **Negative control:** a predicate that does not match its index errors `42P10` | pass |

The negative control is the important one: it shows the other eleven results are
evidence that the `ON CONFLICT` targets genuinely match their indexes, rather than
statements that silently did nothing.

### Tests to be written before the corresponding code

1. `RawJobRepository`, on real PostgreSQL: duplicate ingestion is a no-op; changed
   content adds one row; `lastSeenAt` advances on re-observation; the two insert paths
   are both exercised; a no-identifier record never collides with an identifier-bearing
   one.
2. `JobRepository`: rerun with identical content leaves one Job; changed content updates
   the same Job and repoints `rawJobId`; two sources with the same `identityKey` stay
   separate; `identityKey` absent is rejected rather than promoted.
3. Funnel counters (§7.8) across all of the above, including `undeduplicable`.
4. Extension of `tests/failure/worker-kill.spec.ts` to the collection path: kill mid-run,
   reap, rerun, and assert no duplicate `RawJob` or `Job` rows and consistent funnel
   counts.
5. `GUARDED_PARTIAL_INDEXES` in `tests/integration/partial-indexes.spec.ts` gains the two
   new `raw_jobs` indexes by name *and* predicate; the Job index is asserted as a plain
   unique index (it has no predicate by design).

Index/page-level behaviour is Postgres's own; job-identity resolution logic is already
covered by 24 unit tests in `tests/unit/job-identity.spec.ts`.

### What has actually been implemented

- **Increment 1 — schema and repositories** (`0f60ae8`, `c6539da`): the migration, both
  repositories, and the extended index guard. `partial-indexes.spec.ts` now guards the two
  `raw_jobs` partial indexes by name *and* predicate, and asserts
  `one_job_per_source_identity` is a **plain** unique index with no predicate.
  Mutation-checked: pointing the identifier insert's `ON CONFLICT` at the other predicate
  fails with `42P10 (*no unique or exclusion constraint matching the ON CONFLICT
  specification*)`; swapping the Job index for a partial one fails the guard.
- **Increment 2 — URL trust, identity resolution and the collection pipeline**: see the
  final report accompanying the change. The URL-trust tests are the guard for the
  declaration: removing it makes `resolveSourceRecordIdentity` fall through to `fp:` and the
  `uses the canonical url only when the adapter declares it trustworthy` test fails.

## 9. The collection use case (`RunSourceCollection`)

`src/application/ingestion/run-source-collection.ts` performs SRS 7.7 for one source and
records the SRS 7.8 funnel. It computes every fingerprint and identity key here, in the
domain, and passes them to the repositories; no repository invents one.

### Deliberate deviation from the literal SRS 7.7 ordering

SRS 7.7 numbers "acquire source content" (1) and "apply source rate limits" (2) before
"create SourceRun" (3). This implementation **opens the run first**, for three reasons:

1. SRS 7.6 requires source-level exclusivity *for collection*. The run row is that lock,
   so it must be taken before any network work or two workers can collect one source.
2. `CollectionContext.sourceRunId` is required by the reviewed adapter port, so the
   adapter cannot be called without a run.
3. An acquisition failure would otherwise leave no record at all, and the SRS 7.8 "HTTP
   failures" metric could never be populated.

The run is a plain row, never a long transaction: no transaction is held across the
network call or across records. This is recorded as a deviation rather than hidden.

### Step 10 is not performed

"Schedul[ing] enrichment/matching work" is deferred: those stages do not exist yet, and
enqueueing work for an unregistered handler produces guaranteed permanent failures. A
documented gap is better than invented failures.

### Funnel mapping

| SRS 7.8 stage | Source | Persisted as |
|---------------|--------|--------------|
| `collected` | records the adapter returned | `jobsDiscovered` |
| `parsed` | records whose `normalize` did not throw | derived: `jobsDiscovered - parseFailures` |
| `valid` | records passing collection-time validation (`= parsed` today) | not persisted; equals `parsed` |
| `unique` | records that created a Job | `jobsAccepted` |
| — | records deduped into an existing Job | `jobsDuplicate` |
| — | identity-less records | `undeduplicable` |
| — | identity on the `fp:` basis | `fallbackIdentities` |

The arithmetic `collected = parsed + parseFailures` and
`parsed = valid = unique + duplicates + undeduplicable` is asserted in
`tests/integration/collection-idempotency.spec.ts`, so a record cannot vanish between
stages.

`jobsRejected` is always `0`: the SRS defines no collection-time rejection rule, and
Appendix E is explicit that an `UNUSABLE` description is persisted "for traceability and
funnel metrics". Collection must not discard it.

### Status derivation

| Condition | Status |
|-----------|--------|
| acquisition failed | `FAILED`, `httpFailures = 1`, concrete error in `errorSummary` |
| aborted by worker shutdown (during acquisition or mid-loop) | `PARTIAL`, no HTTP failure claimed, so no false source fault |
| zero collected and the source declared `RESULTS_EXPECTED` | `PARTIAL`, `unexpectedZeroResults = true` |
| one or more records failed to normalize | `PARTIAL` |
| otherwise | `SUCCEEDED` |

An identity-less record does **not** by itself make a run `PARTIAL`. The SRS defines no
such acceptance criterion; the outcome is carried by the `undeduplicable` counter
instead, which avoids inventing a health rule.

### Crash safety

An abandoned run is recovered by reaping runs still active beyond `staleRunSeconds`
*before* opening the new one (ENG-025, SRS 7.6), which is why that input is required.
Recovery is also what makes a retried attempt idempotent: identical evidence conflicts on
the partial indexes and only `lastSeenAt` advances, and a Job keyed by the same identity
is refreshed rather than duplicated.

