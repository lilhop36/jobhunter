# Ingestion audit — 2026-10-23

Phase 4 of the roadmap. Read-only: adapters, pipeline, lifecycle, repositories, tests and the live
development database. No source, schema or test change is made by this report.

Baseline `791f9a6`. Snapshot taken `2026-10-23T18:35Z` against the development database
(`jobhunter`), 3 approved sources, 16 runs, 92 jobs, 96 raw captures, 228 matches, 1 outbox row.

## 1. Snapshot caveat

The last successful run of every source is ~27–28 hours old while the schedules are 3 h and 6 h:

| Source | Schedule | Last success | Age at snapshot |
| --- | --- | --- | --- |
| EffoySira | 6 h | 2026-10-22 14:48Z | 27.8 h |
| Ethiojobs | 6 h | 2026-10-22 14:45Z | 27.8 h |
| JobWebEthiopia | 3 h | 2026-10-22 15:29Z | 27.1 h |

The worker was not running. Every number below describes the last observed state, not current
source health, and two findings (I-03, I-06) are consequences of code that landed *after* that
last run.

## 2. Source inventory

| | EffoySira | Ethiojobs | JobWebEthiopia |
| --- | --- | --- | --- |
| Approval record | `docs/sources/effoysira.md` APPROVED | `ethiojobs.md` APPROVED | `jobwebethiopia.md` APPROVED |
| Access | STATIC_HTML | STATIC_HTML | STATIC_HTML |
| Entry point | `/category/job/` pages → each post | `/jobs?page=N` (`__NEXT_DATA__`) | `/jobs/` page → each post |
| Politeness | 800 ms between requests | 800 ms between listing pages | `Crawl-delay: 30` honoured on **every** request |
| Run budget | 2 listing pages (18 records) | 2 listing pages (24 records) | 1 listing page + 6 posts (6 records) |
| Recorded identifier | none → URL identity | slug (see I-07) | none → URL identity |
| Runs / succeeded | 13 / 5 | 2 / 1 | 1 / 1 |
| Discovered / accepted / duplicate | 90 / 80 / 10 | 24 / 24 / 0 | 6 / 6 / 0 |
| HTTP failures recorded | 6 | 1 | 0 |
| Undeduplicable / fallback identities | 0 / 0 | 0 / 0 | 0 / 0 |
| Job identity basis | 62 `url:` | 24 `sid:` | 6 `url:` |
| Jobs / raw captures | 62 / 66 | 24 / 24 | 6 / 6 |

EffoySira's 8 failed runs: 6 recorded acquisition failures (`TypeError: fetch failed`), 1 run
reaped after being RUNNING for 27,113,238 ms (7.5 h) with `LEASE_EXPIRED`, and 1 older failure not
reconstructable from the retained rows. Its current `HEALTHY` reflects the last run, which
succeeded — consistent with the documented policy (`SOURCE_HEALTH_POLICY_VERSION`), not with the
62 % run-failure rate.

No adapter returns zero on a run that reached the listing. Every successful run hit its page/record
budget exactly (18, 24, 6), so the budget is the binding constraint, not the source's volume.

## 3. Findings

### I-01 — Critical: an HTTP failure can be recorded as a successful, healthy, zero-job run

The chain, all verified in code and reproduced in a scratch run:

1. Each adapter's `get()` returns `null` on **any** non-2xx (`ethiojobs.ts:123-130`,
   `effoysira.ts:170-177`, `jobwebethiopia.ts:222-229`), and `collect` treats `null` as "stop
   reading" (`ethiojobs.ts:149`, `effoysira.ts:191-193`, `jobwebethiopia.ts:251`). The run
   therefore ends with 0 (or fewer) records and no error.
2. `httpFailures` is incremented only when `collect` *throws*
   (`run-source-collection.ts:316-349`); an HTTP 503 never does.
3. `resultExpectation` defaults to `UNKNOWN` (`run-source-collection.ts:211`) and **no production
   caller supplies one**: the handler does not accept it (`source-collection-handler.ts:80-87`) and
   the runtime does not pass it (`apps/worker/runtime.ts:164-174`). No source row or registration
   carries it.
4. `0 records + UNKNOWN` → `isUnexpectedZeroResult` false (`source-run.ts:86-88`) → run
   `SUCCEEDED` → source `HEALTHY` (`source-health-policy.ts:78-84`).
5. `adapter.healthCheck()` would catch the 503, but it has **no production caller** — only the
   port and tests reference it.

Reproduced: Ethiojobs adapter against a 503 router returned 0 records, and
`isUnexpectedZeroResult(0, UNKNOWN) === false` while `isUnexpectedZeroResult(0, RESULTS_EXPECTED)
=== true`.

Consequence: a blocked or dead source is indistinguishable from a quiet one, every
`unexpectedZeroResults` column reads `false`, and the source stays `HEALTHY`. SRS 4.9 ("detect
abnormal source behavior"), 7.8 ("unexpected zero results"), FR-020 and AC-018 are effectively
unenforced. The 14-day validation could count a dead source as healthy.

Smallest fix: carry the approval record's declared expectation (`docs/sources/*.md` already say
`RESULTS_EXPECTED`) into the registration and thread it through the handler. Counting non-2xx as an
acquisition failure is a second, larger change (it needs a port-level notion of "partial page") and
should be designed, not bolted on.

### I-02 — High: Ethiojobs application paths are captured but never normalized

The source declares an application method on **24 of 24** records (`rawPayload.applicationMethod`:
13 `EMAIL`, 5 `ATS`, 5 `CAREER_PAGE_LINK`, 1 `BOTH`), with email/URL/form fields alongside. Every
stored job has `applicationMethod = UNKNOWN` (24/24), because `normalizeRawEvidence` reads only the
description text and `rawPayload` is not an input to any normalizer.

`hasUsableApplicationPath` returns false for `UNKNOWN`
(`normalizers/application-target.ts`), and notification eligibility gates on it
(`notification-eligibility.ts:120-123`). So an entire approved source can never notify, although
SRS 3.5/line 673 requires "a usable application path before notification" and the evidence for one
is already stored. The deferral is deliberate and commented ("structured wiring deferred"), but its
consequence was not: 24 jobs are silently un-notifiable.

Fix direction: accept source-declared structured application fields as explicit evidence and map
them (EMAIL → `EMAIL` + `applyEmail`, ATS / career-page → `ONLINE_URL` + `applyUrl`), falling back
to the text extractor. Declared fields only — nothing inferred. Existing jobs update in place on the
next collection because identity is unchanged.

### I-03 — High: the declared expiry date never becomes the application deadline

All 24 Ethiojobs raw records carry `rawPayload.dateExpiry`; 0 of 92 jobs has
`applicationDeadline`. `parseDeadline` is fed only the description text, so a structured,
publisher-declared expiry is invisible to FR-019. EffoySira is different: **61 of 62** descriptions
contain a labelled deadline ("Application Deadline: October 24, 2026") and its parser handles them
correctly — verified by running `parseDeadline` on those exact strings. Those jobs have no deadline
only because the deadline feature (`6cf2e11`) landed at 21:55 on 2026-10-22, *after* the last
successful collection at 14:48. The next EffoySira run should populate them; Ethiojobs will not,
even after a run.

Fix direction: same shape as I-02 — an explicit source-declared date field, parsed with
`parseDate`, with the text parser as fallback.

### I-04 — Medium: a source that stops running still reports HEALTHY

`healthStatus` is derived from the last finished run only (`source-health-policy.ts`), so a source
that has not run for 28 hours is `HEALTHY`. The dashboard shows `lastSuccessfulRunAt`, so an
operator can notice, but nothing computes or flags staleness and the API exposes no such field. The
SRS requires detection of "abnormal source behavior" (4.9) without defining staleness; this is a
gap to state, not a breach to fix silently. Cheapest honest version: derive it on read
(`now - lastSuccessfulRunAt > 2 × schedule`) in the dashboard and `/api/sources`. Needs an owner
decision because the threshold is a product choice.

### I-05 — Medium: acquisition errors are undiagnosable, and a reaped run shows a 7.5 h duration

All six EffoySira acquisition failures are recorded as `TypeError: fetch failed`. `describeError`
(`work-task-handler.ts:39-48`) keeps only `name: message` and drops `error.cause`, which is where
Node puts `ECONNRESET`, `ENOTFOUND`, `CERT_*` and timeouts. The operator cannot tell a DNS failure
from a TLS failure from a blocked request.

Separately, `LEASE_EXPIRED` was recorded with `durationMs = 27,113,238` because reaping only runs
while a worker is alive: a run abandoned on 2026-10-21 was not finalized until the next start. The
number is truthful, but it reads like a 7.5-hour crawl unless the status is read with it.

Fix: append a bounded `cause` chain to `describeError` (no secrets are involved in network causes).

### I-06 — Medium: removal detection exists but has no production caller; dead-link detection does not exist

`SweepSourceLifecycle` has a dedicated real-PostgreSQL suite
(`tests/integration/lifecycle-sweep.spec.ts`) and zero production callers. Nothing in the worker invokes it, so `REMOVED` can never be set in
production, and all 92 jobs are `ACTIVE`. `NOT_FOUND` has no implementation at all (a dead-link
probe is still an open ADR item from the drift report, D9). `EXPIRED` is wired (a deadline sweep
runs at the head of every scoring task) but has nothing to act on until deadlines are stored.

Consequence: FR-019 is implemented and tested but inert. The listing-presence sweep is the cheap
half — the evidence it needs ("not observed in the latest successful run") is already recorded.

**Why it must not be wired as it stands (measured 2026-10-23).** The sweep's "informative run"
definition (`SUCCEEDED` and `jobsDiscovered > 0`) assumes a run observed the whole catalogue.
It does not: discovery is page-capped (I-08). Running the sweep's own read model against the
current database shows what the first wired sweep would do:

| Source | ACTIVE jobs | Latest qualifying run discovered | Would move to REMOVED |
|---|---|---|---|
| EffoySira | 62 | 18 | **44** |
| Ethiojobs | 24 | 24 | 0 |
| JobWebEthiopia | 6 | 6 | 0 |

Those 44 EffoySira jobs are older postings that fell outside the two-page window; they are
still published. Retiring them would convert "not looked at" into "gone" — exactly the
missing-evidence-as-negative-evidence failure ENG-001 forbids, and it would also cancel any
future notification for them.

The prerequisite is therefore not a trigger but a **coverage signal**: a run may only qualify
when the adapter reached the end of the source's listing (Ethiojobs' payload carries
`meta.lastPage`; EffoySira and JobWebEthiopia expose pagination links). Proposed design: add a
per-run "catalogue exhausted" flag, qualify the sweep on it, and only then invoke the sweep
after a successful run. Until that exists, `REMOVED` stays unreachable by design, and the
fix-order item is downgraded from "wire it" to "give it coverage evidence first".

### I-07 — Medium: Ethiojobs identity uses the full slug while the approval record declares only the id segment stable

`docs/sources/ethiojobs.md` says "the leading id segment is a stable external identifier (ADR-0001
id-bearing captures)"; the adapter stores the **whole** slug as `sourceJobIdentifier`
(`ethiojobs.ts:163-165`), so the key is `sid:2qdbkevrhp-senior-accountant`, not
`sid:2qdbkevrhp`. If the site regenerates the slug tail when a title is edited, the same posting
forks into a second Job — a second match and a second notification.

This cannot be fixed silently: changing the basis re-identifies all 24 existing jobs. Either the
adapter truncates to the id segment (with a one-time re-collection and a documented identity
migration) or the approval record is amended to declare the full slug stable. Owner decision.

### I-08 — Medium: discovery budgets are capped, and every successful run hits the cap

EffoySira returns at most 2 × 9 = 18 records, Ethiojobs 2 × 12 = 24, JobWebEthiopia 6. The last
successful run of each produced exactly the cap. A posting pushed past the window (busy week, many
edits) is never observed, and there is no measurement of how often that happens. The page budgets
are documented as a deliberate politeness/freshness trade-off, so this is a measurement gap rather
than an error: compare `raw captures per run` against `discovered per run` before changing a budget.

The cap also blocks removal detection: a run that stops at page 2 cannot support "unseen means
gone", so the presence sweep stays unwired until a run can declare it covered the listing (see
I-06). Raising the budget alone does not fix that — the signal is coverage, not volume.

### I-09 — Low: fixtures are synthetic, not captured, and there is no dead-link case

SRS line 1340 asks for representative fixtures per source including clean, malformed, duplicate,
missing-field, Ethiopian-date, salary-ambiguous and dead-link cases. The adapter suites are thorough
(unreachable listing, unreachable post, abort mid-run, nested-div extraction, ad-container
selection, Cloudflare email decoding, listing caps, rate limits, health states), but every page is a
hand-written minimal snippet, and there is no dead-link fixture. A theme change that keeps the
synthetic tests green while breaking the live markup remains possible.

### I-10 — Info: cross-source duplication is unmeasured

Same canonical URL across sources: 0. Same content fingerprint across sources: 0. Same normalised
title + company across sources: 0. Identity is source-scoped by design (`(sourceId, identityKey)`,
ADR-0001), so the first genuinely cross-posted job will produce two Jobs, two matches and two
notifications. This is the open D8 decision, not a regression; the current data simply cannot
measure it yet.

### I-11 — Info: EffoySira company is always UNKNOWN, and that is deliberate

0 of 62 jobs have a company. The adapter leaves it null because the text only names the employer in
the title, and guessing would be fabrication. Matching must therefore not depend on company for this
source. Not a defect; recorded so the matching evaluation does not misread it as extraction failure.

### I-12 — Info: `jobsRejected` has no producer

`RunSourceCollection.finish` writes `jobsRejected: 0` with a comment explaining that the SRS defines
no collection-time rejection rule. Truthful, unexercised column; SRS 7.8 does not require it.

## 4. Field extraction scorecard

Stored values, last observed state:

| Field | EffoySira (62) | Ethiojobs (24) | JobWebEthiopia (6) |
| --- | --- | --- | --- |
| Title | 62 | 24 | 6 |
| Company | **0** (by design, I-11) | 24 | 6 |
| Location text | 23 | 24 | 6 |
| Published date | 62 | 24 | 6 |
| Description | 62 (all SUFFICIENT, min 1,283 chars) | 24 (min 366) | 6 (min 533) |
| Deadline | 0 (text present in 61; see I-03) | **0** (declared in 24; I-03) | 0 (text present in 1) |
| Salary known | 21 | 3 | 2 |
| Employment type known | 1 | 5 | 3 |
| Application method known | 53 | **0** (declared in 24; I-02) | 6 |
| Description quality UNUSABLE | 0 | 0 | 0 |

`employmentType` is 83/92 UNKNOWN overall even though both Ethiojobs (`type`) and JobWebEthiopia
(`jobType`) declare it structurally — the same unused-`rawPayload` root cause as I-02, with a
direct effect on the matching factors. The text classifier alone finds it in 9 records.

## 5. Duplicate handling (as built)

- Identity is resolved once, in the domain, from a declared basis: stable source id → trusted
  canonical URL → title+company+location fallback → null (`job-identity.ts:239-250`). URL trust is
  a per-source declaration, not inferred (`url-normalizer.ts:26-36`). Placeholder values (`N/A`,
  `-`, `TBD`) fold to absent, and the fallback refuses fewer than two real fields.
- Uniqueness is `(sourceId, identityKey)`; no cross-source constraint exists (ADR-0001). The upsert
  never derives identity from content and never erases the existing row's evidence.
- Raw captures are deduplicated by `(sourceId, sourceIdentifier, contentHash)` or
  `(sourceId, contentHash)`, so a re-observation costs nothing and a changed posting keeps both
  captures (provenance).
- Observed behaviour matches: 10 duplicate observations absorbed without creating jobs; 0
  undeduplicable; 0 fallback identities; 66 raw captures for 62 jobs on EffoySira (4 changed
  postings re-captured, identity unchanged).
- The identity rules are covered by `tests/unit/job-identity.spec.ts` (416 lines) and idempotency by
  `tests/integration/collection-idempotency.spec.ts`.

A repost with a changed deadline or title keeps its identity (URL/id basis) and updates in place; a
*different* posting with an identical title does not merge unless the source has no identifier and
no trusted URL, in which case it falls to the `fp:` basis and the count is visible in
`fallbackIdentities`. That is the documented limitation, and it is measured rather than assumed.

## 6. What is correct

- Adapter registration is gated by an `APPROVED` record, enforced by
  `tests/unit/source-approval-records.spec.ts`; each record states access mechanism, robots/terms
  outcome, identifier field, calendar and currency.
- Politeness is real, not aspirational: JobWebEthiopia waits 30 s between **every** request, the
  others 800 ms, and the tests assert the delay counts.
- Raw evidence is persisted before promotion, and a failed normalize keeps the capture
  (`run-source-collection.ts:365-399`). Provenance is per field with a conversion-method version.
- One source's failure does not stop another: the scheduler enqueues one independent task per due
  source, and runs are separate rows. On 2026-10-22 the 14:06 outage failed EffoySira and Ethiojobs
  independently; at 14:45 Ethiojobs succeeded while EffoySira failed again — neither run blocked or
  caused the other.
- Run failures are visible with `sourceId`/`runId` in logs, on `/dashboard` (source health table:
  health, last success, latest run, zero-result flag) and through `/api/sources` and
  `/api/sources/:id/runs` (funnel counters included).
- Malformed or unreachable pages are handled without inventing records: a post that cannot be read
  is skipped rather than represented by its listing excerpt.

## 7. Recommended order

| # | Finding | Size | Why first |
| --- | --- | --- | --- |
| 1 | I-01 expectation wiring | S | Restores the only automatic signal that a source went silent; blocks a false "healthy" during validation. |
| 2 | I-05 error cause | XS | Six failures are currently undiagnosable. |
| 3 | I-02 + I-03 structured application path and expiry | M | Unlocks 24 jobs and makes FR-019 work for the source that declares expiry. |
| 4 | I-06 give the presence sweep a coverage signal, then wire it + ADR for dead links | M | Not a trigger problem: measured, wiring it today would retire 44 of 62 live EffoySira jobs (see I-06). |
| 5 | I-08 measure budget saturation, I-09 capture fixtures | S-M | Evidence before changing budgets. |
| 6 | I-04 staleness flag, I-07 identity basis | decision | Both are product/record decisions, not mechanical fixes. |

## 8. Fix progress

| Item | Status | Commit | Evidence |
| --- | --- | --- | --- |
| I-01 expectation wiring | done | `9855e1a` | All three registrations carry the approval record's `RESULTS_EXPECTED`; the handler forwards it. Regression drives scheduler → queue → worker → handler with an empty listing and asserts `PARTIAL` + `unexpectedZeroResults` + `DEGRADED`. |
| I-05 error cause | done | `9855e1a` | `describeError` follows up to three `cause` links and bounds the line at 500 chars; a `fetch failed` now reads `(cause: read ECONNRESET)`. |
| I-02 structured application path | done | `af02176` | Ethiojobs maps its declared method/email/link in the adapter; declared evidence outranks text; a malformed declared email and an ATS record with no target stay UNKNOWN. |
| I-03 declared expiry | done | `af02176` | `date_expiry` is parsed by the shared date parser and stored as `applicationDeadline`; an unparsable declared value falls back to the description's labelled deadline. |
| I-06 presence sweep | **blocked** | — | Measured above: wiring it today retires 44 of 62 live EffoySira jobs. Needs the coverage signal first. |
| I-04, I-07 | open | — | Owner decisions. |
| I-08, I-09, I-10, I-12 | open | — | Unchanged. |

The I-01 remainder (a non-2xx during listing acquisition is still swallowed by the adapter and
reported as zero records) is unchanged and deliberately out of this increment: it needs a
port-level notion of a partial page. With the expectation wired, the visible outcome is now
`PARTIAL`/`DEGRADED` rather than `SUCCEEDED`/`HEALTHY`, so the failure is no longer invisible.
