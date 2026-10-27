# Full-system audit — 2026-10-25

**Scope:** the entire repository in its current working-tree state, not only committed code.
**Method:** read-only review of the SRS, AGENTS.md, ADRs, schema and migrations, application/worker
code, adapters, tests, operator scripts and documentation; plus targeted execution: type checking,
Prisma migration status, a live API smoke test, `npm audit`, a live source-markup check, and a direct
probe of the deadline parser. No code, migration or configuration was changed.
**Status of this document:** findings and recommendations. Two items were fixed afterwards, on
2026-10-27: P0 item 1 (the drifted schema) and M10 (the timestamp type), recorded in §7. Every
other finding stands as written, and the evidence below describes the tree as the audit found it.

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
   header is unchecked (DNS rebinding).
3. **A crash during collection can disable a source for its whole schedule interval.** Work-task
   retries exhaust before the stale-run reaper is allowed to act, and nothing re-enqueues the
   source after reaping.
4. **Two data-integrity rules are violated in the direction AGENTS.md forbids:** a partial capture
   can overwrite known facts with UNKNOWN, and the deadline parser can invent a deadline from an
   unrelated date elsewhere on the same line.

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

#### M2 — A source run has no liveness signal; a live run can be reaped and a zombie can keep writing — **new, verified**

`reapStaleRuns` uses only `startedAt` (`prisma-source-run-repository.ts:232-248`), and `SourceRun`
has no heartbeat column. A run whose post-acquisition persistence exceeds 900 s can be reaped while
alive, releasing the one-active-run lock; a replacement run starts; the original's finalize is
discarded (`run-source-collection.ts:535-541`) and its record loop checks only the worker shutdown
signal, not run status. The discarded outcome loses counters, health and the coverage claim, and
matching may already have been enqueued before finalization (`:502-506`).
**Fix:** add `lastHeartbeatAt` updated between record batches and reap by inactivity; or enforce a
total run deadline below the stale bound. Verify run liveness before each batch.

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

#### M7 — Backup and disaster recovery are scripts, not an operating capability — **known (D19), verified**

The scripts work and the drill passed, but no schedule, off-machine copy, encryption or retention
policy is installed (`docs/engineering/backup-and-restore.md:8-11,146-155,200-207`). The drill
verifies table sets and row counts only (`scripts/restore-drill.mjs:133-203`); it does not verify
`_prisma_migrations`, constraints/indexes, or that the restored schema supports the current code.
A backup taken from the currently drifted `jobhunter` database would restore with matching counts
and still be unusable — exactly the H1 failure. This is not hypothetical: the recorded 17-table /
484-row drills were taken from the 13-migration database, so they certify a schema that lacks the
column the current code requires. Existing-archive mode warns rather than fails on differences.
The drift report's AC-019 **PASS** therefore overstates the assurance: it proves the archive
restores, not that backups are scheduled, encrypted, off-machine, or schema-current.
**Fix:** install a schedule and encrypted off-machine destination; make the drill compare
`_prisma_migrations` (or required columns) and run one application query against the restored
database; treat AC-019 as PARTIAL until then.

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
| FR-001..003 sources/scheduling | Implemented; crash recovery gap H3/M2 |
| FR-005..007 validation/quality | Strong deterministic gates; reduced-yield detection missing (H7) |
| FR-008 dedupe | Within-source strong; cross-source absent (D8) |
| FR-009/014 skills & confidence | Blocked by missing `JobSkill` (D4) |
| FR-012..016 matching | Implemented and explainable; skills weight permanently unknown |
| FR-017..018 notifications/feedback | Durable delivery; feedback API exists; AC-017 UI/buttons absent (D13) |
| FR-019 lifecycle | ACTIVE/EXPIRED/REMOVED implemented; `NOT_FOUND` absent; coverage rules sound but ordering assumption and races remain (M1/M2/M6) |
| FR-020 health | Latest-run policy sound for zero results; reduced-yield missing (H7) |
| FR-021 backup | Scripts + drill verified; no schedule/off-machine/encryption (M7) |
| SRS 8.1/8.2 auth/ownership | Not met (H2) |
| SRS 6.5 accessibility | Mostly met; unlabeled textareas/error association (M9) |
| SRS 7.8 observability | Partial; source health page exists, yield drift and funnel metrics missing (H7/L8) |
| AC-017 / AC-020 | Not met (D13/D21) |
| AC-018 | Logic exists; operator view currently unreachable because of H1 |
| AC-019 | Passes as "an archive restores with matching counts"; does not prove schedule, encryption, off-machine copy or schema currency (M7) |

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
   and re-enqueue sources whose runs were reaped.
3. **Fix the EffoySira timestamp (H6)** — `collectedAt: now`, validate the date, finalize on
   per-record failure.
4. **Fix refresh merge (H4)** and **deadline anchoring (H5)** with regression tests.

### P1 — this week

5. **Authorization/Host/Origin (H2)**: session-derived identity, API token, ownership checks,
   Telegram-link session requirement, loopback fail-closed.
6. **Yield-drift detection (H7)** and correct D20.
7. **Lifecycle CAS + restore-on-observation (M1)** and **source-run heartbeat (M2)**.
8. **Outbox recovery/revalidation and shutdown order (M3)**.
9. **Backup schedule + migration-aware drill (M7)**.

### P2 — hardening and hygiene

10. Adapter SSRF/size caps and HTTP-failure accounting (M5); provenance/identity fixes (M6).
11. CI, lint, Prettier dependency, build/migration step in `verify`, supervision/alerting (M8).
12. Fastify 5 upgrade and dependency re-audit (M8).
13. Accessibility labels/error association and test strengthening (M9).
14. Decide the ENG-022 timestamp convention before applying the pending migration (M10).
    **Done 2026-10-27** — ENG-022 won; see the resolution note under M10.
15. Low items L1–L10, starting with cursor validation and docs corrections.

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
