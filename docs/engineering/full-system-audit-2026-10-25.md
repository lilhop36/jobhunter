# Full-system audit — 2026-10-25

**Scope:** the entire repository in its current working-tree state, not only committed code.
**Method:** read-only review of the SRS, AGENTS.md, ADRs, schema and migrations, application/worker
code, adapters, tests, operator scripts and documentation; plus targeted execution: type checking,
Prisma migration status, a live API smoke test, `npm audit`, a live source-markup check, and a direct
probe of the deadline parser. No code, migration or configuration was changed.
**Status of this document:** findings and recommendations. Eleven items were fixed afterwards: P0
item 1 (the drifted schema), M10 (the timestamp type), H3 (crash recovery), H4 (the refresh merge),
H5 (deadline anchoring) and H6 (the orphaned run) on 2026-10-27; M2 (the source-run liveness signal,
which also closed the heartbeat half H3 left open) on 2026-10-31; M1 (the lifecycle write race and
restore-on-observation) on 2026-11-01;
H7 (reduced-yield detection) on 2026-10-28, and H2 (the authorization boundary), M7 (the schema-aware
drill, verified copy, retention and schedule commands) and H7's source-silence half on 2026-10-30 — H7's
funnel-metric half stays open, H2's TLS half needs an operator certificate, and M7 stays PARTIAL
until an encrypted off-machine copy is recorded. Each is recorded on the finding itself. Every other
finding stands as written, and the evidence below describes the tree as the audit found it.

The audit used four independent review tracks (security/API, reliability/concurrency,
data/ingestion/lifecycle, requirements/operations/tests). Every finding below marked
**verified** was re-read in the code or reproduced during consolidation; claims that could not be
reproduced were downgraded or dropped.

---

## 1. Verdict

The architecture and the engineering discipline are strong: deterministic domain logic, explicit
UNKNOWN handling, append-only raw evidence, a fenced PostgreSQL work queue, a transactional
outbox, and an unusually good failure-test suite for a project of this size.

The system is **not safe to operate as-is**, for four independent reasons:

1. **The running API is ahead of or behind its database.** The current working tree needs 14
   migrations; the local `jobhunter` database has 13. `/dashboard` and `/api/sources` return 500
   today, while `/health` still returns `{"status":"ok"}`. *(Resolved 2026-10-27 for the schema:
   `jobhunter` is at 15 migrations and both pages return 200. `/health` is still the static stub,
   so the detection gap that made this outage invisible is open.)*
2. **There is no authorization boundary.** Every JSON route and the web "login" trust a
   caller-supplied `userId`; the only control is the default loopback binding, and even the `Host`
   header is unchecked (DNS rebinding). *(Closed 2026-10-30 — see H2 and ADR-0011: identity comes
   from a signed credential or the session, `Host`/`Origin` are checked, and a non-loopback bind
   fails closed. TLS on such a bind is still not implemented.)*
3. **A crash during collection can disable a source for its whole schedule interval.** Work-task
   retries exhaust before the stale-run reaper is allowed to act, and nothing re-enqueues the
   source after reaping.
4. **Two data-integrity rules are violated in the direction AGENTS.md forbids:** a partial capture
   can overwrite known facts with UNKNOWN, and the deadline parser can invent a deadline from an
   unrelated date elsewhere on the same line. *(Both were fixed 2026-10-27 — see H4 and H5; H4
   leaves one field, `applicationDeadline`, clearing on refresh, because the repository pins that
   as intentional and it is an owner decision rather than a bug.)*

None of these is architectural. They are bounded bugs and one deployment step, but they must be
fixed before the pipeline is trusted for real alerts.

---

## 2. Repository and runtime state

| Item | Observed |
| --- | --- |
| HEAD | `45ff2b0` |
| Working tree | **not clean**: 37 tracked files modified (+1,510 / −178), 8 untracked paths at audit start (this report is a ninth) |
| Committed migrations | 12 |
| Migrations in the working tree | 14 (the two FR-019 coverage migrations are untracked) |
| Migrations applied to local `jobhunter` | 13 — `20261024140000_source_run_listing_coverage_floor` missing |
| Migrations applied to `jobhunter_test` | 14 (tests migrate their own database) |
| Type check | `npx tsc --noEmit` passes |
| Full test suite | 71 files / 857 tests passed earlier on this same working tree (2026-10-25) |
| Production dependency audit | 2 high, 1 moderate (Fastify 4.29.1 direct) |
| Live API smoke test | `/health` 200; `/dashboard` and `/api/sources` 500 `P2022` |

The uncommitted increment is substantial: windowed lifecycle coverage (ADR-0010), the backup and
restore-drill scripts, and the documentation that describes both. A deployment built from HEAD does
not contain that work; a deployment built from the working tree without `prisma migrate deploy`
crashes on the pages that query the new column. This is a release-engineering gap, not just a local
inconvenience.

---

## 3. Findings

Severity reflects impact if the system is trusted as described by its documentation. "Known" means
already recorded in `srs-implementation-drift-2026-10-23.md`; "new" means not previously recorded.

### High

#### H1 — The schema is drifted from the code, and readiness cannot detect it — **new, verified**

- `npx prisma migrate status` reports `20261024140000_source_run_listing_coverage_floor` unapplied.
- A live run of the built API returns 500 on `/dashboard` and `/api/sources` with
  `The column source_runs.oldestListingPublishedAt does not exist in the current database.`
- `apps/api/main.ts:51` returns a static `{status:'ok'}`; `startApi` (`:115-120`) has no migration
  or connectivity preflight, and `apps/api/config.ts:55-64` validates shape, not reachability.
  `/health` therefore stays green while every data page is broken.
- `README.md:33-39` leaves `prisma migrate deploy` as a manual step; tests apply migrations to
  `jobhunter_test` themselves (`tests/support/db.ts`), so the suite cannot detect a skipped deploy.

**Impact:** current outage; any operator or uptime check relying on `/health` is misled. AC-018's
"unexpected zero-result runs are visible" is unreachable in this state.
**Fix:** apply the migration now; make migration deployment a release step; add a readiness check
that opens a trivial query and verifies the expected migration; commit the two migrations and the
working increment.

**Resolved 2026-10-27 (partially).** The schema is deployed: `jobhunter` is at 15 migrations, and
`/health`, `/dashboard`, `/login`, `/api/jobs`, `/api/matches` and `/api/sources` all return 200
with no `P2022` in the log. The column was converted to `timestamptz(3)` in a second, forward-only
migration rather than by editing `20261024140000`, because `jobhunter_test` had already recorded
that migration's naive checksum — amending it would have broken `migrate deploy` against every
database that applied it. The unfixed half of this finding is the half that matters operationally:
`/health` is still the static `{status:'ok'}` with no connectivity or migration preflight, and the
suite still cannot detect a skipped deploy, so the same drift would recur undetected.

#### H2 — No authorization boundary anywhere; loopback is the only control — **known (D1), wider than documented, verified**

- `GET /api/matches` and `GET /api/notifications` omit `userId` and return **all candidates**
  (`apps/api/routes/matches.ts:40-47`, `notifications.ts:49-54`).
- `PUT /api/profile` trusts `?userId=` (`apps/api/routes/profile.ts:79-98`); source runs can be
  triggered anonymously (`apps/api/routes/sources.ts:97-142`).
- `/login?userId=<uuid>` mints a session and CSRF cookie for any stored profile
  (`apps/api/routes/web.ts:298-307`); `/profile` and `/settings/telegram` GETs mint a session
  anonymously for the sole profile (`web.ts:342-361`, `557-567`).
- `POST /api/telegram/link` mints a link token for any body `userId`
  (`apps/api/routes/telegram-link.ts:46-50`). Redeeming it in an attacker's Telegram binds that chat
  to the victim's account (`src/application/telegram/telegram-linking.ts:51-59`), redirecting
  future job alerts. The route comment's claim that the token "exposes nothing about them" is false
  in consequence.
- No `Host`/`Origin` allowlist exists (`apps/api/main.ts:45-47,117`). A rebinding page becomes
  same-origin with `127.0.0.1` and can read responses and perform JSON writes.
- `API_HOST` accepts any address (`apps/api/config.ts:58`); one environment change exposes
  everything in cleartext, with no auth and no `Secure` cookie (`src/application/web/session.ts:105-112`).
- The HTML match detail has no ownership check either (`apps/api/routes/web.ts:166-172`), so a
  session for candidate A can read candidate B's match evidence by id.

**Impact:** any local process, or a malicious page open in the operator's browser under rebinding,
can read candidate PII, overwrite the profile, mint sessions, trigger collection and redirect
Telegram alerts. SRS 8.1/8.2 require authentication and server-side ownership.
**Fix:** derive identity only from the session; remove `userId` from browser routes; add a bearer
token (or Unix socket) for `/api/*`; enforce ownership in the service/repository layer; validate
`Host`/`Origin`; fail closed when `API_HOST` is not loopback unless auth and TLS are explicitly
enabled; require a session to mint Telegram link tokens.

**Resolved 2026-10-30, except the TLS half.** ADR-0011 records the decision; the implementation came
in four commits. Identity is now read only from a principal that a root `preHandler` proves before
any route runs — a bearer credential the deployment signed, or the browser's session — deny-by-path,
so a route added later is covered without its author remembering to ask. Every `userId` the caller
names is refused with 400 rather than ignored, on `/api/*` and on the pages alike. The browser earns
its session by opening a signed, 60-second, single-use link that only `npm run login` can mint, and
the candidate chooser that handed out sessions for any stored id is gone; `npm run token` covers
scripted callers. `/matches/:id` compares the row's owner to the principal and answers a foreign
match with the same 404 a missing one gets. `Host` is allowlisted, mutating requests must be
same-origin, and a non-loopback `API_HOST` now refuses to boot without
`API_ALLOW_EXTERNAL_BIND=true` and `API_ALLOWED_HOSTS`. The sign-in code lives in a query parameter,
and Fastify 4 cannot redact just the query, so request logging is this process's own and writes the
path, never the URL (SRS 8.5). What remains open is the "unless … TLS" clause: the bind fails closed
and names its hosts, but opting in does not require a certificate, so an externally bound API is
still cleartext. Two consequences the operator should know: signature buys unforgeability, not
revocation, so rotating `AUTH_SECRET` invalidates every outstanding link, token and session; and a
session is in-memory, so a restart logs the browser out.

#### H3 — A crash during collection can dead-letter recovery and idle the source for 3–6 hours — **new, verified**

`reapStaleRuns` only reaps runs older than `SOURCE_STALE_RUN_SECONDS` (default 900 s,
`.env.example:27`). Work tasks retry five times with a 5/10/20/40 s backoff
(`src/infrastructure/work-tasks/prisma-work-task-repository.ts:41,159,256-293`) and default unknown
errors to retryable (`src/application/worker/work-task-handler.ts:90-97`). A run left `RUNNING` by a
crash is not reapable for 15 minutes, but every retry between 0 and ~2 minutes hits
`SourceRunActiveError` (`src/infrastructure/ingestion/prisma-source-run-repository.ts:141-159`) and
the task becomes `DEAD_LETTER`. The scheduler's due time is `max(source_runs.startedAt) + interval`
(`src/application/scheduling/source-scheduler.ts:136-145`,
`src/infrastructure/ingestion/prisma-job-source-repository.ts:79-80`), so the source is not
attempted again until its next 3 h or 6 h schedule. Health remains last-known-good; nothing alerts.

The README's "restarting the worker is safe … a killed process cannot wedge a source" is therefore
true only for the run lock, not for collection cadence.
**Fix:** do not consume attempts on `SourceRunActiveError` while the run is younger than the stale
window; re-enqueue sources whose runs were just reaped; add a source-run heartbeat so liveness is
not inferred from age alone. Add a failure test that crashes after `openRun` and asserts a retry
before the schedule interval.

**Resolved 2026-10-27, except the heartbeat half (which is M2).** Two changes, both in the recovery
path. A collection task that meets `SourceRunActiveError` no longer fails: the handler raises
`DeferredWorkTaskError`, the worker calls the new `WorkTaskRepository.defer`, and the task returns to
`PENDING` with its claim's attempt **returned** and a `runAfter` one stale window (plus a 30 s poll
margin) away. The retry therefore lands exactly when the abandoned run becomes reapable, and
`RunSourceCollection` reaps it on that attempt before opening its own run — a crash now costs one
stale window instead of a dead letter. Repeating the deferral cannot exhaust the budget: the
repository test claims and defers five times with `maxAttempts = 2` and still finds `PENDING,
attempts = 0`. Second, `SourceScheduler.runOnce` enqueues a collection for every source whose run it
just reaped, because a reaped run's `startedAt` is the source's last attempt and due-ness would
otherwise hold the source until its next 3–6 h interval. The active-only dedupe key makes this
idempotent when the crashed task already deferred itself, and disabled sources are skipped.

Tests: the full chain is a regression test in `source-scheduler.spec.ts` ("recovers a source after a
crash without waiting for its schedule interval") — a `RUNNING` run 10 minutes old, one worker claim
asserting `PENDING` with `attempts 0`, then the window elapsed and a second claim ending with the
old run `FAILED` and a new one `SUCCEEDED` with its job accepted. Defer semantics are also pinned at
the repository (`work-task-queue.spec.ts`) and worker (`work-task-worker.spec.ts`) layers.

**The heartbeat asked for above landed on 2026-10-31 as M2**, so the window is now measured from a
run's last report rather than its start: a collection that legitimately outlives
`SOURCE_STALE_RUN_SECONDS` is no longer reclaimed while it is alive. The queue half is unchanged -
deferral is still one stale window, now a window of silence.

#### H4 — Re-observation overwrites known canonical facts with UNKNOWN/null — **new, verified**

`JOB_REFRESH_COLUMNS` writes every `EXCLUDED` value unconditionally
(`src/infrastructure/ingestion/prisma-job-repository.ts:24-53,191-193`). All three adapters still
emit records when a page is readable but a field is missing (e.g.
`src/infrastructure/adapters/effoysira.ts:258-299`, `ethiojobs.ts:314-348`,
`jobwebethiopia.ts:315-393`). A layout change or partial parse therefore replaces a stored
description, title, salary, application target or deadline with `NULL`/UNKNOWN. Because
`classifyDeadline` turns an `EXPIRED` job back into `ACTIVE` when the stored deadline disappears
(`src/domain/lifecycle/deadline-policy.ts:80-90`), this also causes status churn from missing data.

**Impact:** silent degradation of matching and notification quality; a previously valid job can
become un-notifiable, then re-appear, with no evidence of why. This contradicts AGENTS.md's
"missing evidence is not negative evidence".
**Fix:** merge field-by-field: overwrite only when the incoming value is present evidence; never
clear a populated canonical field on a refresh. Cover with a regression test for a partial capture.

**Resolved 2026-10-27, except for one field that needs the owner's decision.** Every other column
now keeps the stored fact when the new capture carries nothing — NULL scalars via `COALESCE`, and
the enum columns via a guard on their own `UNKNOWN` member, because `UNKNOWN` means "nothing was
read", not "the source now says it is unknown". `descriptionQuality` travels with `description`
rather than reclassifying a description the row kept, and `provenance` merges by key
(`stored || incoming`) so a fact this merge preserved keeps the origin it was recorded with. The
newest capture is still untouched in `raw_jobs`, so nothing about the observation is lost.

`applicationDeadline` was left clearing on refresh: `tests/integration/job-repository.spec.ts:285`
pins "a recapture that no longer states a deadline clears the column" as deliberate, on the ground
that a source which stopped stating one has changed its statement. That reading is what produces
the status churn described above, and it is the same absence-vs-negative-evidence question the
AGENTS.md rule answers the other way. It is a product decision, not a bug fix, so the merge is
asymmetric and the code says so. Deciding it means either retiring that test's premise (and the
`EXPIRED`-to-`ACTIVE` churn with it) or accepting that a partial parse can expire-proof a posting.

#### H5 — The deadline parser can fabricate a deadline from an unrelated date — **new, reproduced**

`phraseAfter` takes everything after the label to the end of the line, up to 80 characters
(`src/domain/normalizers/deadline.ts:65-66`), and `parseDeadline` accepts the first date-shaped
substring anywhere in that phrase (`:88-96`). Reproduced:

```
"Deadline: until filled. Posted 30 Oct 2026"
  -> deadlineAt 2026-10-30T00:00:00.000Z
     evidence    "Deadline: until filled. Posted 30 Oct 2026"
```

**Impact:** a job that explicitly has no deadline can be marked `EXPIRED` one day after publication.
This is fabricated data in the exact sense SRS 3.5 / AGENTS.md prohibit, and it removes the job
from matching and notification.
**Fix:** anchor the date to the label and the first clause; treat "until filled", "open until
filled", "rolling" and similar phrases as UNKNOWN; add the reproduced case as a regression test.

**Resolved 2026-10-27.** `phraseAfter` now cuts at a sentence boundary and
`DEADLINE_EXTRACTION_VERSION` is `V2`. The cut is punctuation **followed by whitespace**, because a
declared `DD.MM.YYYY` date is written with dots and no spaces — `Deadline: 30.10.2026` must survive
whole, and `Deadline: until filled. Posted 30 Oct 2026` must not. The no-deadline phrases are
matched against the **start** of the clause only: `Deadline: 30 Nov 2026 (or until filled)` is a real
deadline and would be wrong to discard. The reproduced input is a regression test, along with the
dotted-format and comma-date cases that the naive cut would have broken. No stored row needed
repair: `jobhunter` had zero Jobs with `applicationDeadline` set, so the fabrication was latent in
this corpus rather than already written into it.

#### H6 — One malformed EffoySira timestamp fails and orphans the whole run — **new, verified**

`effoysira.ts:298` stores `new Date(publishedTime)` as `collectedAt` (instead of the observation
time used by the other two adapters). `article:published_time` is copied verbatim from the page
(`effoysira.ts:84-87`), so a malformed value produces an `Invalid Date`; the raw repository then
calls `.toISOString()` (`src/infrastructure/ingestion/prisma-raw-job-repository.ts:93`) and throws.
The per-record persistence loop has no `try/catch` (`run-source-collection.ts:373-454`), so the run
is never finalized: it stays `RUNNING` and the failure path of H3 takes over.

**Impact:** one bad meta tag can stop an entire source for hours and lose every record from that
acquisition. It also mislabels publication time as collection time in the evidence trail.
**Fix:** always set `collectedAt: now`; validate the parsed publication date before constructing a
`Date`; wrap per-record persistence failures so a bad record is counted and the run is finalized
`FAILED` or `PARTIAL` with evidence retained.

**Resolved 2026-10-27.** `collectedAt` is now always the observation time, which is what the field
means and what the other two adapters already recorded; the publication date continues to travel as
`rawPublishedDateText` for the shared normalizer, where a bad value correctly yields UNKNOWN instead
of an `Invalid Date`. The run was orphaned by the *loop*, not by this adapter, so both per-record
writes are now guarded: a record whose raw evidence cannot be stored is logged, noted and skipped,
and a record that parsed but could not be promoted is logged with its raw evidence retained. Either
case finalizes the run `PARTIAL` with the offending index and reason in `errorSummary`, and it can
never report `SUCCEEDED`, because records were lost. Two regression tests drive the real PostgreSQL
pipeline through repository decorators that reject one selected record each, and assert no `RUNNING`
SourceRun is left behind. A malformed `article:published_time` is itself now a tested case.

#### H7 — SRS §7.8 reduced-yield detection is absent; the drift register says MATCH — **new, verified**

SRS line 1264: "A source that suddenly produces zero jobs or **sharply reduced extraction yield**
must produce an operator-visible warning." The health policy has no baseline or ratio input; it
derives `HEALTHY` from any `SUCCEEDED` run (`src/domain/health/source-health-policy.ts:70-103`).
Only the zero-result case is anomalous, and only for sources declared `RESULTS_EXPECTED`
(`run-source-collection.ts:456-464`). A selector change that still yields a handful of cards is
recorded as healthy. A source that stops being scheduled also stays at its last known health
forever: health is written only when a run finalizes, so there is no staleness signal.
D20 nevertheless marks FR-020/§7.8 **MATCH** (`srs-implementation-drift-2026-10-23.md:118`).
Additionally, `jobsRejected` is hard-coded to `0` (`run-source-collection.ts:513`), and pipeline
funnel metrics stop at collection; matched/notified are not measured.
**Impact:** the failure mode the SRS explicitly requires detecting is invisible; collection can
decay for days while the dashboard says healthy.
**Fix:** persist a per-source baseline (cards listed, posts parsed, valid records, parse-failure
ratio) and emit `DEGRADED` plus a log/operator warning when yield falls outside a documented
threshold. Correct D20 to PARTIAL. Add tests with a synthetic 80% yield drop.

**Resolved 2026-10-28 for a scheduled source that runs, except the unscheduled-source half.** The
rule is `classifyYieldDrift` (`src/domain/health/source-yield-drift.ts`): the run's parsed yield is
compared with the **median of its last three clean runs** (SUCCEEDED and catalogue-exhausted), and a
yield strictly below **half** of that median, with a baseline of at least **five** records, returns a
drift verdict that `classifySourceHealth` turns into `DEGRADED`. A success whose yield collapsed
still counts as a success - `lastErrorAt` would claim an error that did not happen - so the run stays
`SUCCEEDED` and only the source's verdict changes, which is what the dashboard renders
(`apps/api/routes/web.ts:746`). A `warn` line with the listed/parsed/baseline numbers is written only
after the run is really finalized, so a reaped outcome cannot raise a phantom alarm.

Two decisions worth recording. The baseline is **read from the runs' own counters**
(`SourceRunRepository.recentCleanYields`) rather than copied into a per-source table: the per-run
counters already are the persisted baseline, and a copy would be one more thing to keep in sync. And
runs that were capped, partial or aborted are never used or judged by volume - an incomplete look is
not evidence about the source. `parsed` is `jobsDiscovered - parseFailures`, the funnel identity
ADR-0001 already fixes.

`jobsRejected` remains `0` deliberately: ADR-0001 §4 decides it, because the SRS defines no
collection-time rejection rule and `parsed = unique + duplicate + rejected + undeduplicable` closes
with zero. Filling it would require inventing a rejection rule, which is not this finding's fix.

Tests: unit thresholds and the 80% drop (`yield-drift-policy.spec.ts`), health mapping
(`source-health-policy.spec.ts`), the repository selection (`source-run-yield-baseline.spec.ts`), and
the end-to-end verdict and log line through the real collection use case
(`source-health.spec.ts`, "reduced-yield drift"), including the capped and partial exemptions.

**The staleness half is resolved 2026-10-30.** The rule is `classifySourceSilence`
(`src/domain/health/source-silence.ts`): a source is silent once **two whole declared intervals**
have passed with no *successful* collection. It measures `lastSuccessfulRunAt`, not `lastAttemptAt` -
an attempt that failed is already reported by the run that failed, and silence means nothing arrived -
against the source's own `schedule` (`parseScheduleInterval`), never a global window, so a `15m`
source and a `1d` source do not go quiet at the same age. The multiplier is an engineering default,
not an SRS number, and is the owner's to tune; one missed interval is normal jitter, and alarming on
it would train the operator to ignore the alarm.

Three states produce **no verdict**, and none of them may be read as healthy: the source has never
succeeded (no age to measure); it has no schedule (nothing is due, so nothing is overdue - it is
manually collected); its schedule is present but unparseable (the scheduler already reports that as
its own error, and inventing an interval would be inventing a fact). That last pair is the honest
limit of this fix: a source whose `schedule` was *emptied* is reported as not measurable rather than
silent, because an operator edit is not the source misbehaving, and the dashboard says "not
measurable" instead of guessing.

The decision is evaluated in two places on purpose. The scheduler pass
(`src/application/scheduling/source-scheduler.ts`) writes `DEGRADED` and emits one `warn` line - the
durable signal - and only ever stamps a source that still says `HEALTHY`, because a `FAILING` source's
failed run states the truer reason. `lastErrorAt` is deliberately not dated: no run failed, no run
happened. The write is fenced - `markSourceSilent` re-applies the age bound and the `HEALTHY`
precondition inside its `WHERE`, since the pass's read and its write are not one transaction and a
collection that succeeded in between owns the row again. The read surfaces (`/api/sources`,
`/api/sources/:id`, and the dashboard's "Delivery" column) derive the same verdict per response, which
is the half that keeps speaking when the collecting process is not running at all: the failure being
detected is "the worker died and nobody noticed", so a rule that lives only inside the worker cannot
be its only reporter. The published `silence` object omits `silentBefore` - the bound is the store's
write fence, not a reader's fact.

Tests: the rule, its boundary and the three unmeasured states (`tests/unit/source-silence.spec.ts`);
the pass, say-once, `FAILING` left alone, the fenced refusal *and* its positive control
(`tests/integration/source-scheduler.spec.ts`); the published payload including the absence of
`silentBefore` (`tests/integration/api-sources.spec.ts`); the dashboard column
(`tests/integration/web-pages.spec.ts`). Binding the bound as a `Date` instead of ISO text made that
fence three hours too permissive on this session's zone - recorded in
`src/infrastructure/ingestion/db-clock.ts`.

Funnel metrics are still the open part of this finding: `jobsRejected` stays `0` by ADR-0001 §4 (above),
and collected→matched→notified is not measured as a funnel view.

#### H8 — Known high-impact requirement gaps still open

These are already recorded and accepted/deferred, but they remain material to whether the system
meets its own SRS:

| Ref | Gap | Consequence |
| --- | --- | --- |
| D4 | No `JobSkill`; `skills: []`, `requiredExperience: null` | 30% of the matching weight and the confidence ladder are permanently unknown; matches are systematically under-informed |
| D8 | Dedupe is source-scoped only | The same job from two sources produces two Jobs, two matches, potentially two alerts |
| D13 | Telegram sends plain text with no buttons/feedback; no web feedback form | AC-017 is not met; a Telegram-only user cannot classify alerts |
| D21 | 14-day notification precision is never measured | AC-020 cannot be evaluated |

D9 (`NOT_FOUND` never set), D10 (application URLs never verified) and D17/D18 (AI deferred) remain
documented deferrals.

### Medium

#### M1 — Lifecycle and deadline reconciliation are last-writer-wins — **new, verified**

`applyLifecycleStatuses` updates by id only (`prisma-job-repository.ts:311-332`). The presence sweep
and deadline expiry each re-read only the statuses they own and then write unconditionally
(`sweep-source-lifecycle.ts:40-81`, `expire-deadlines.ts:39-76`). With a second worker, or a
re-claimed task, both can read `ACTIVE` and write `REMOVED`/`EXPIRED` in either order; the losing
reason is unrecoverable because neither policy owns the other state. The same unconditional write
can overwrite a newer observation during a sweep.
A related gap: a `REMOVED` job re-observed by a run that makes no coverage claim stays `REMOVED`
until a later covered run, because the sweep only runs for `SUCCEEDED` runs with
`catalogueExhausted || oldestListingPublishedAt !== null`
(`src/application/ingestion/source-collection-handler.ts:111-134`). Presence should restore
`ACTIVE` independent of coverage.
**Fix:** carry the expected status per update and add `lifecycleStatus = expected` to the grouped
`updateMany`; restore `ACTIVE` on observation; add concurrent sweep/expiry tests.

**Resolved 2026-11-01.** `LifecycleStatusUpdate` carries `expectedStatus` — the status the deciding
pass read — and `applyLifecycleStatuses` groups by the `(expected → target)` pair and adds
`lifecycleStatus: expected` to each `updateMany`, returning the count actually written. A pass whose
row moved underneath it therefore does not apply: the other writer's determination stands, the next
pass re-reads it before deciding again, and the divergence is logged as
`lifecycle sweep left newer state untouched` / `deadline reconciliation left newer state untouched`
with `decided`/`applied`/`superseded`, so a lost race is visible instead of mysterious. `EXPIRED`
and `NOT_FOUND` can no longer be flattened by a presence pass that never saw them, and vice versa.
The restore half needed only the handler's gate: the candidate read model already qualified a run
that *captured* the Job (`rj."lastSeenAt" >= r."startedAt"`), and rule 2 of ADR-0010 §2.2 restores on
presence alone, so an observation retires nothing new and the sweep now runs after every `SUCCEEDED`
run, claimed coverage or not. Retirement stays restricted to runs that covered the Job, so no
additional job is retired by the wider gate. Tests: `lifecycle-sweep.spec.ts`
(`restores a retired job observed by a run that claimed no coverage at all`, plus a repository-level
fence test and a `RacingJobs` test in which the deadline policy wins the race) and
`deadline-expiry.spec.ts` (the mirror case: a presence sweep retires during the deadline pass's read).

#### M2 — A source run has no liveness signal; a live run can be reaped and a zombie can keep writing — **new, verified**

`reapStaleRuns` uses only `startedAt` (`prisma-source-run-repository.ts:232-248`), and `SourceRun`
has no heartbeat column. A run whose post-acquisition persistence exceeds 900 s can be reaped while
alive, releasing the one-active-run lock; a replacement run starts; the original's finalize is
discarded (`run-source-collection.ts:535-541`) and its record loop checks only the worker shutdown
signal, not run status. The discarded outcome loses counters, health and the coverage claim, and
matching may already have been enqueued before finalization (`:502-506`).
**Fix:** add `lastHeartbeatAt` updated between record batches and reap by inactivity; or enforce a
total run deadline below the stale bound. Verify run liveness before each batch.

**Resolved 2026-10-31.** `source_runs` gained `lastHeartbeatAt timestamptz(3)`
(migration `20261030210000_source_run_heartbeat`). A collection stamps it when the run opens and
restamps between records every `SOURCE_RUN_HEARTBEAT_MS`, defaulting to `min(60 s, half the stale
window)`; an explicit interval that could not report inside the window is refused at startup by
`resolveSourceRunHeartbeatMs`. `reapStaleRuns` judges that instead of `startedAt` —
`COALESCE("lastHeartbeatAt", ("startedAt" AT TIME ZONE 'UTC')) < now() - stale` — so the fallback to
age applies only to rows predating the column, and the naive side is converted because this session's
zone is not UTC (ENG-022). Duration alone is no longer evidence of death.
The zombie half closes on the same write: `heartbeat()` is fenced to the active statuses and returns
whether the row is still ours, so the loop learns it lost the lock at the record whose beat failed,
stops writing, and finalizes as `PARTIAL` with the run's claims withheld — no exhausted-catalogue
claim, no window floor, `attributableToSource = false` — so a worker disappearing does not mark down
the source's health. A beat that *throws* deliberately does not stop the loop: an absent answer is
not evidence of death. H3's deferral arithmetic is untouched, since the window is still the bound a
recovery waits out, now measured from the last report.
Operator-visible: `/api/sources*` publishes `lastHeartbeatAt` and the dashboard "Latest run" cell
renders `RUNNING (40 s ago)` against `RUNNING (3 h ago)` — two situations the status alone conflated.
Tests: `source-run-liveness.spec.ts` (beats, stops on refusal, withholds claims, survives a throwing
beat, plus the resolver's bounds); the `run liveness (audit M2)` group in
`source-run-reaper.spec.ts` (old-but-reporting survives, young-but-silent is reclaimed, the legacy
NULL fallback with a positive control, DB-clock stamping, single-run scoping); `worker-config.spec.ts`
for the refusal; `api-sources.spec.ts` and `web-pages.spec.ts` for the published field and the cell;
and `tests/failure/collection-crash.spec.ts` now waits on silence rather than age.

#### M3 — Outbox rows can be stranded, and dispatch does not revalidate eligibility — **new, verified**

`claimDue` moves up to 20 rows to `PROCESSING`; `renderNotificationMessage` runs outside the
per-row `try` (`src/application/notification/dispatch-notifications.ts:75`), and `claimDue` only
selects `PENDING`. `recoverAbandoned` runs only at process start
(`apps/worker/runtime.ts:220-235`; repository `:160-166`). A render error, DB error in
`markSent`/`markFailed`, or a crash therefore strands rows until the next restart. Recovery resets
all `PROCESSING` rows with no lease, so a rolling deploy with two workers can reset and resend an
in-flight row. `cancelIneligible` rechecks only lifecycle and deadline
(`prisma-notification-outbox-repository.ts:168-188`); it does not recheck AC-004's usable
application path or FR-018's "not relevant" feedback, so a pending alert can still be delivered
after the apply URL disappears or the user rejects that job.
Similarly, `alreadyNotified` counts `CANCELLED`/`FAILED` rows
(`prisma-notification-facts-reader.ts:29-47`), so a cancelled event can suppress a later eligible
one permanently.
**Fix:** catch render errors per row; recover abandoned rows before every pass or release the
claimed batch on failure; add a claim token/lease for multi-instance dispatch; use the full
notification eligibility predicate in `cancelIneligible`; exclude terminal non-sent rows from
`alreadyNotified` where re-notification is intended.

#### M4 — A source without a resolvable adapter is re-enqueued every 30 seconds forever — **new, verified**

The handler throws `PermanentWorkTaskError` before opening a run when no adapter resolves
(`source-collection-handler.ts:90-93`). `lastAttemptAt` is derived only from `source_runs`, so no
run means the source is always due; the scheduler ignores the enqueue result
(`source-scheduler.ts:139-145`). Every pass creates a task that fails permanently, health stays
`UNKNOWN`, and failed task rows accumulate.
**Fix:** persist an attempt/failure timestamp on `JobSource`, or exclude unresolvable sources from
`listSchedulable` and surface them as a configuration error.

#### M5 — Adapter HTTP handling permits SSRF and masks source failures — **new, verified**

JobWebEthiopia extracts arbitrary `href` values from source HTML (`jobwebethiopia.ts:212`) and
fetches them (`:317`) through a helper that follows redirects and calls `res.text()` with no size
cap (`:224-230`; EffoySira `:172-179`; Ethiojobs `:233-239`). A compromised or hostile listing can
make the worker fetch internal/cloud-metadata URLs, and a huge response can exhaust memory. All
three helpers also collapse every non-2xx response to `null`; `httpFailures` is incremented only
when acquisition throws (`run-source-collection.ts:324-363`), so 403/429/500 responses look like
record-level parse misses and understate source health.
**Fix:** allowlist scheme and host for extracted links; resolve relative URLs against the listing
base and reject unresolved ones; use `redirect: 'manual'` with revalidation; cap response bytes;
return typed status and count non-2xx as HTTP failures.

#### M6 — Provenance and identity edge cases — **new, verified**

- `rawContentHash` excludes `rawPayload` (`src/domain/normalizers/job-identity.ts:114-127`). An
  Ethiojobs change to `applicationMethod`, `applicationEmail`, `dateExpiry` or `careerPageLink`
  reuses the stored raw row while the canonical Job is updated from the new record: the Job claims
  a fact its linked evidence does not contain. Include the canonicalized payload and bump the hash
  version.
- Ethiojobs uses the full slug as `sourceJobIdentifier` (`ethiojobs.ts:314`), although
  `docs/sources/ethiojobs.md:7` designates the leading id segment as the stable identifier. A title
  edit forks identity and can leave the old Job to be retired. Use the id segment.
- The windowed coverage rule assumes the listing is newest-first: the floor is the oldest date
  among the records read (`effoysira.ts:261-274`, `jobwebethiopia.ts:345-360`). If a source ever
  renders an older card after a newer one on a partially-read page, a live job can fall inside the
  claimed window and be retired. Verify monotonic ordering per source or bound the floor to the last
  fully-read page.
- EffoySira retains no raw payload (`effoysira.ts:295-297`, deliberate), so its extracted fields
  cannot be re-verified after the page changes; `collectedAt` is publication time, not observation
  time (`:298`).

#### M7 — Backup and disaster recovery are scripts, not an operating capability — **known (D19), partially resolved 2026-10-30**

The scripts work and the drill passed, but no schedule, off-machine copy, encryption or retention
policy is installed (`docs/engineering/backup-and-restore.md:8-11,146-155,200-207`). The drill
verified table sets and row counts only (`scripts/restore-drill.mjs:133-203`); it did not verify
`_prisma_migrations`, constraints/indexes, or that the restored schema supports the current code.
A backup taken from a database that is behind the code restores with matching counts and is still
unusable — exactly the H1 failure. This was not hypothetical: the recorded 17-table / 484-row drills
were taken from the 13-migration database, so they certified a schema that lacked the column the
current code required. Existing-archive mode also warned rather than failed on differences.

**Resolved 2026-10-30 for everything the repository can do on its own.**

The drill now checks schema currency, not just shape. It compares Prisma's migration ledger between
source and restore **by name and checksum**, requires the restored ledger to cover the migrations in
this checkout, and runs the scheduler's own query (`PrismaJobSourceRepository.listSchedulable`)
against the restored database. Fresh mode fails on any of those; existing-archive mode reports them
as notes, because recovering onto an older archive legitimately continues with
`npx prisma migrate deploy`. The 2026-10-25 archive, which the old drill passed as a clean match,
now reports the two migrations it predates — and forcing it through fresh mode exits 1 with those
names. That is the finding's failure mode, caught by the check that replaced it.

Backups can now have a second copy: `BACKUP_COPY_DIR` writes one and proves it before the run claims
success — byte-identical SHA-256, non-empty, readable by `pg_restore --list`, destination outside
the repository and not the archive's own directory, plus an explicit warning when the copy shares a
volume with the archive. `npm run backup:prune` implements the documented 14-daily/8-weekly window,
dry run unless `--apply`. `npm run backup:schedule` prints the daily task and registers it only with
`--apply`. Retention and scheduling stay operator-run: deleting backups and installing OS tasks are
not things a script should do unprompted.

**Still open, and why AC-019 remains PARTIAL.** This host has one volume (`C:`, at capacity), so
there is nowhere on it to put a copy that survives losing it; no encrypted off-machine archive
exists, and no schedule is installed. The scripts do not encrypt — there is no key management here
to verify a decryption against, and an untested cipher is not security. `backups/backup.log` has no
watcher, so a run of failed backups would be quiet. The drill also compares ledger names and
checksums rather than the DDL, so index or constraint drift no migration introduced would pass.
Recording an encrypted off-machine copy and drilling it closes the finding.

#### M8 — Release gate, supervision and dependency hygiene — **new, verified**

- No CI configuration exists; no lint script or ESLint configuration exists. `npm run format`
  invokes `prettier`, which is not in `devDependencies` (`package.json:16,29-37`) and is not
  installed, so it fails on a clean checkout.
- `verify` runs disk check + typecheck + tests (`package.json:17`), not `build`, not a migration
  deploy against an empty database, and not the failure suite separately. The test suite is strong;
  the gate around it is thin.
- There is no process supervisor, log rotation, aggregation or alert sink in the repository; the API
  and worker are independent npm scripts.
- `npm audit --omit=dev`: 2 high, 1 moderate. `fastify@4.29.1` is a direct dependency
  (`package.json:43`) with validation/content-type advisories; the fix is Fastify 5.12.7, a
  semver-major upgrade. `find-my-way` (via Fastify) and `fast-uri` are also flagged.
- The failure suite has no contention test (SRS 9.5): worker-kill, timeout and zero-result cases are
  covered, but not two workers racing the same run/outbox row.
- The test-database guard accepts **any host** as long as the database name ends in `_test`
  (`tests/support/db.ts:35,53`). That is deliberate for CI, but it also means a remote database
  named `*_test` will be migrated and TRUNCATEd. Prefer loopback by default with an explicit
  opt-in for non-local hosts.

#### M9 — Accessibility: form controls lack accessible names, and the test overstates coverage — **new, verified**

The three textareas for skills, target roles and location preferences have a `<legend>` and a hint
but no `<label>`/`aria-label` (`apps/api/web/profile-form.ts:323,335,343`), and the error summary is
not associated with the offending fields (`:262-268`). The accessibility test
(`tests/integration/web-pages.spec.ts:190-203`) checks `lang`, skip link, `main`, `th scope`, one
`h1`, and absence of scripts/styles/images, then claims "the structural accessibility the SRS
asks for". It does not check control labels, error association, focus order or contrast.
**Fix:** label every control (can be visually hidden), add `aria-invalid`/`aria-describedby` for
field errors, add table captions, and extend the test to assert label association.

#### M10 — New timestamp columns violate ENG-022's timezone-aware rule — **new, verified**

SRS ENG-022 says "New timestamp columns use a timezone-aware type"
(`docs/SRS/JobHunter-v1.1-SRS.md:1612`). Both new migrations add `TIMESTAMP(3)`
(`prisma/migrations/20261024140000_source_run_listing_coverage_floor/migration.sql:6`), following
the existing naive-timestamp convention rather than the requirement. Practical impact is low — all
writes go through the UTC database clock and the new floor is a date-only comparison — but the
schema choice is permanent once applied, and this is the moment to decide it. Either convert the
column to `TIMESTAMPTZ(3)` (and record the project-wide convention), or record an explicit ADR
that accepts naive UTC columns despite ENG-022.
**Fix:** decide before applying the still-pending migration; do not let the existing convention
silently override a written engineering requirement.
**Resolved 2026-10-27:** the convention was decided in favour of ENG-022. The floor is
`timestamptz(3)` (`20261024150000_source_run_listing_coverage_floor_timestamptz`), written as an
explicit UTC instant, and the window predicate compares
`(publishedAt AT TIME ZONE 'UTC') > oldestListingPublishedAt` so the retirement boundary cannot
move with the session's zone. The conversion is forward-only, for the checksum reason recorded
under H1. `jobs.publishedAt` deliberately stays a naive `timestamp(3)` holding UTC — converting
the pre-existing columns is a separate change with a data rewrite, and ADR-0010 §2.1 records the
mixed-type comparison instead.

### Low

| Ref | Finding | Evidence / note |
| --- | --- | --- |
| L1 | Non-UUID match/notification cursors reach `::uuid` casts and become 500s instead of 400s | `apps/api/routes/matches.ts:128-133`, `notifications.ts:111-118` |
| L2 | Session `Map` grows without a sweep; `/login?userId=` can create unbounded entries; no rate limiting anywhere | `src/application/web/session.ts:30,44-56`; `apps/api/config.ts` |
| L3 | The API process is given the worker's `TELEGRAM_BOT_TOKEN` because both load the whole `.env` | `package.json:11-14`; `apps/api/config.ts:55-64` |
| L4 | ADR-0009 claims JSON writes require `X-CSRF-Token`; no route checks it | `docs/architecture/decisions/0009-web-authentication-csrf.md:32,57`; no implementation |
| L5 | Docs and comments are stale: the drift report says the tree is clean; ADR-0006 still says the notification write path is not built; the ingestion audit uses present-tense "Critical" for a fixed item; `apps/worker/main.ts:17-18` says the adapter registry is empty (three adapters exist); `apps/worker/runtime.ts:144-146` says no profile endpoint exists (one does) | `srs-implementation-drift-2026-10-23.md:5,23`; ADR-0006; `ingestion-audit-2026-10-23.md:51-82,315-319` |
| L6 | No DB `CHECK` constraints for salary min ≤ max, probability bounds, match score bounds or non-negative counters; invariants live only in application code | `prisma/schema.prisma`; ENG-021 focuses on keys, but the gap is real |
| L7 | `canonicalizeUrl` turns a relative path into `https://<first-segment>/...` instead of resolving it; latent because today's adapters pass absolute URLs | `src/domain/normalizers/url-normalizer.ts:68-94`; live JobWeb markup confirmed absolute |
| L8 | Funnel metrics stop before matched/notified; matched/notified counts are not exposed | `run-source-collection.ts:478-520`; D20 notes the missing funnel page |
| L9 | Coverage retires after a single missed informative run; intermittent truncation will flap | documented in `lifecycle-policy.ts:41-43` |
| L10 | `NOT_FOUND` is never produced; consumers cannot distinguish "source says gone" from "deadline passed" | known D9 |
| L11 | Two suite files failed `npm run verify` on a `beforeAll` **hook** timeout (Vitest's 10 s default) while every test inside them passed: `applyTestMigrations()` shells out to `prisma migrate deploy`, and that CLI exceeds 10 s when the live worker shares the machine | Observed 2026-11-01 (`process-lifecycle.spec.ts`, `job-match-repository.spec.ts` — 22/22 green standalone, exit 0). **Fixed the same day** with `hookTimeout: 120_000` in `vitest.config.ts`; per-test budgets are untouched, so a genuinely slow test still fails. |

---

## 4. What is genuinely solid

- **Domain/data boundaries.** Deterministic matching with the exact SRS weights, UNKNOWN
  renormalisation and explainable per-factor evidence (`src/domain/matching/`); no AI in the fact
  path.
- **Evidence model.** Append-only `raw_jobs`, versioned SHA-256 fingerprints, per-field provenance,
  source-scoped identity, and a database-level guard against backfilling identity
  (`prisma/schema.prisma`; ADR-0001).
- **Queue correctness.** Atomic `SKIP LOCKED` claim with a per-claim lease token, heartbeat,
  fenced complete/fail, expiry reaping, and partial unique indexes; the run finalizer writes
  counters and source health in one transaction (`prisma-work-task-repository.ts`,
  `prisma-source-run-repository.ts`). These controls are better than most production queues.
- **Notification durability.** Match + outbox in one transaction with a unique event key; bounded
  retry/backoff, 429 `retry_after`, 10 s send timeout, at-least-once delivery, and a plain-text
  Telegram message (no parse mode).
- **Web security baseline.** Escaping-by-default HTML, whitelist-only `raw()`, strict CSP with
  `default-src 'none'`, no client JavaScript, `nosniff`/`no-referrer`, session-bound constant-time
  CSRF double submit, HttpOnly session cookie, and http(s)-only external links.
- **SQL safety.** All raw SQL uses tagged template parameters; no `$queryRawUnsafe`; static
  `Prisma.raw` fragments only; parameterised cursors cannot inject.
- **Test discipline.** 71 files / 857 tests, including worker kill, SIGTERM, stale-run reaping,
  collection timeout, zero-result classification, notification retry and lifecycle integration
  tests against real PostgreSQL; a `_test`-database safety guard; broad unit coverage of
  normalizers, matching and lifecycle rules.

---

## 5. Requirement snapshot

| Area | State |
| --- | --- |
| FR-001..003 sources/scheduling | Implemented; crash recovery fixed 2026-10-27 (H3) and the run liveness signal 2026-10-31 (M2) |
| FR-005..007 validation/quality | Strong deterministic gates; reduced-yield detection added 2026-10-28 (H7) |
| FR-008 dedupe | Within-source strong; cross-source absent (D8) |
| FR-009/014 skills & confidence | Blocked by missing `JobSkill` (D4) |
| FR-012..016 matching | Implemented and explainable; skills weight permanently unknown |
| FR-017..018 notifications/feedback | Durable delivery; feedback API exists; AC-017 UI/buttons absent (D13) |
| FR-019 lifecycle | ACTIVE/EXPIRED/REMOVED implemented; `NOT_FOUND` absent; the run-liveness race closed 2026-10-31 (M2) and the two-policy write race plus restore-on-observation 2026-11-01 (M1); identity-key/provenance retention still open (M6) |
| FR-020 health | Yield drift 2026-10-28 and source silence 2026-10-30 (H7): both §7.8 abnormal-behaviour cases now warn the operator; funnel metrics still open |
| FR-021 backup | Scripts + schema-aware drill; copy/retention/schedule commands exist but no encrypted off-machine copy or installed task (M7) |
| SRS 8.1/8.2 auth/ownership | Met 2026-10-30 (H2, ADR-0011); TLS for an externally bound API still absent |
| SRS 6.5 accessibility | Mostly met; unlabeled textareas/error association (M9) |
| SRS 7.8 observability | Yield drift 2026-10-28 and source silence 2026-10-30; funnel page and matched/notified metrics still missing (L8) |
| AC-017 / AC-020 | Not met (D13/D21) |
| AC-018 | Logic exists; operator view currently unreachable because of H1 |
| AC-019 | Schema currency now proven by the drill (ledger + scheduler query, 2026-10-30); still does not prove schedule, encryption or an off-machine copy (M7) — **PARTIAL** |

---

## 6. Verification performed

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| `npx prisma migrate status` | 14 found; `20261024140000_source_run_listing_coverage_floor` not applied |
| Live API (`API_PORT=3099`, built `dist/`) | `/health` 200; `/dashboard`/`/api/sources` 500 P2022 |
| Full suite (this working tree, 2026-10-25) | 71 files, 857 tests passed |
| Restore drill (recorded 2026-10-25) | 17/17 tables, 484/484 rows; disposable DB dropped |
| `npm audit --omit=dev` | 2 high, 1 moderate |
| Deadline parser probe | reproduced false deadline for "Deadline: until filled. Posted 30 Oct 2026" |
| Live JobWeb listing check | card hrefs are absolute today (relative-URL issue is latent) |
| Working tree | 37 modified, 8 untracked, HEAD `45ff2b0` |

Not performed: production telemetry review (none exists), load/soak testing, multi-worker stress
testing, live collection against all three sources during this audit, Telegram end-to-end delivery,
and a restore of an off-machine encrypted archive. Findings that depend on those conditions are
marked theoretical or downgraded.

---

## 7. Prioritised remediation

### P0 — before the next collection / deploy

1. **Apply `20261024140000_source_run_listing_coverage_floor`** to `jobhunter`; verify
   `/dashboard` and `/api/sources`; commit both migrations and the working increment after review.
   **Done 2026-10-27** — applied, endpoints verified returning 200, committed as `062dae6` and
   `c093e97`; the second migration converts the floor to `timestamptz(3)` (M10). The remaining P0
   items below are still open.
2. **Fix crash recovery (H3)** — do not burn work-task attempts on a fresh `SourceRunActiveError`,
   and re-enqueue sources whose runs were reaped. **Done 2026-10-27** for the queue, and
   **2026-10-31** for the run heartbeat (M2) that completes it.
3. **Fix the EffoySira timestamp (H6)** — `collectedAt: now`, validate the date, finalize on
   per-record failure. **Done 2026-10-27**, including the loop guard that was the real cause.
4. **Fix refresh merge (H4)** and **deadline anchoring (H5)** with regression tests.
   **Done 2026-10-27** — H5 is clause-anchored extraction (`DEADLINE_EXTRACTION_V2`, the reproduced
   input plus the dotted and comma-date cases pinned); H4 is a field-by-field merge with a partial
   recapture regression test, with `applicationDeadline` deliberately left to the owner's call.

### P1 — this week

5. **Authorization/Host/Origin (H2)**: session-derived identity, API token, ownership checks,
   Telegram-link session requirement, loopback fail-closed. **Done 2026-10-30** — ADR-0011, and the
   web sign-in is a one-time local code rather than a `?userId=` link. TLS for an opted-in external
   bind is the remaining half, and installing a certificate is the operator's step.
6. **Yield-drift detection (H7)** and correct D20. **Done 2026-10-28** for a
   source that runs (median baseline, `DEGRADED`, warning) and **done 2026-10-30** for one that
   stopped running (`classifySourceSilence`: two declared intervals without a success, written by the
   scheduler and derived on every read surface). Both §7.8 drift-detection cases now warn the
   operator; D20 stays PARTIAL for the rest of §7.8 — the pipeline funnel view and the notification
   metrics roll-up (L8).
7. **Lifecycle CAS + restore-on-observation (M1)**, and **source-run heartbeat (M2)** —
   **Done 2026-10-31** for the heartbeat and **2026-11-01** for the compare-and-set and the wider
   sweep trigger. Both halves of the item are closed.
8. **Outbox recovery/revalidation and shutdown order (M3)**.
9. **Backup schedule + migration-aware drill (M7)**. **Done 2026-10-30 for the drill and the
   commands** — the drill compares the migration ledger and answers the scheduler's query,
   `BACKUP_COPY_DIR` writes a verified copy, `backup:prune` and `backup:schedule` exist. Installing
   the task and recording an encrypted off-machine copy are the operator's remaining halves.

### P2 — hardening and hygiene

10. Adapter SSRF/size caps and HTTP-failure accounting (M5); provenance/identity fixes (M6).
11. CI, lint, Prettier dependency, build/migration step in `verify`, supervision/alerting (M8).
12. Fastify 5 upgrade and dependency re-audit (M8).
13. Accessibility labels/error association and test strengthening (M9).
14. Decide the ENG-022 timestamp convention before applying the pending migration (M10).
    **Done 2026-10-27** — ENG-022 won; see the resolution note under M10.
15. Low items L1–L10, starting with cursor validation and docs corrections. L11, the test-suite
    hook budget, surfaced during the M1 verification on 2026-11-01 and was fixed the same day.

The known requirement gaps (D4, D8, D13, D21) are product decisions, not audit fixes; they should
remain visible in the drift report and be scheduled before claiming SRS conformance.

---

## 8. Audit limitations

- The audit is read-only and local. No production deployment exists to compare against; the local
  database is the only runtime evidence.
- The full test suite result is from earlier in the same working tree; it was not re-run during
  consolidation to avoid concurrent database truncation while review tracks were active.
- Live source behaviour was spot-checked, not collected end-to-end. Rate limiting/robots compliance
  was reviewed in code, not observed over time.
- Several reliability findings depend on multi-worker or long-running conditions (M1, M2, M3) and
  are reasoned from code and tests, not reproduced in a multi-instance stress run.
