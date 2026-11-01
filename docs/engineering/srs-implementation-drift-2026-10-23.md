# SRS ↔ Implementation Drift Report

**Date:** 2026-10-23
**Last updated:** 2026-11-01 — audit M1 closed: lifecycle reconciliation is now a compare-and-set and the presence sweep no longer waits for a coverage claim. `LifecycleStatusUpdate` carries the status the deciding pass read, `applyLifecycleStatuses` applies each grouped move only while the row still holds it and returns the count actually written, so the presence sweep and the deadline pass cannot overwrite each other's determination — or a newer observation — under a second worker or a re-claimed task; a superseded move is dropped rather than retried and logged with `decided`/`applied`/`superseded`, which is where a lifecycle reason is recorded at all. The handler sweeps after every `SUCCEEDED` run because presence restores on its own evidence (ADR-0010 §8), while retirement still requires a run that read the listing to the end or reached below the Job's date. Earlier: 2026-10-31 — audit M2 closed: `source_runs` gained `lastHeartbeatAt timestamptz(3)`, which a collection stamps when the run opens and restamps between records (`SOURCE_RUN_HEARTBEAT_MS`, default `min(60 s, half the stale window)`), and `reapStaleRuns` now reclaims a `RUNNING` run that has gone quiet past `SOURCE_STALE_RUN_SECONDS` rather than one that merely started long ago. The same fenced write is the loop's ownership check, so a worker whose run was reclaimed stops writing and finalizes `PARTIAL` with its coverage and health claims withheld instead of continuing as a zombie. `/api/sources*` publishes the field and the dashboard "Latest run" cell shows how recently a running run reported. This also closes the heartbeat half H3 left open. Earlier: 2026-10-30 — D20's second §7.8 drift case closed: `classifySourceSilence` (`src/domain/health/source-silence.ts`) calls a source silent after two of its own declared intervals with no *successful* collection, the scheduler writes `DEGRADED` behind a fenced update and warns once, and `/api/sources*` plus the dashboard derive the same verdict so it still speaks when the collector is not running. D20 stays PARTIAL for the rest of §7.8 (funnel view, notification/AI metric roll-ups). Earlier same day: D19/AC-019 corrected to PARTIAL: the restore drill now proves schema currency (migration ledger by name and checksum, plus the scheduler's own query against the restored database) and the repository gained a verified copy destination, retention pruning and a schedule installer, but no encrypted off-machine copy or installed task exists yet. Earlier: 2026-10-28 — D20 yield drift implemented for a source that runs (`classifyYieldDrift`: median of the last three clean runs, `DEGRADED` below half of it, plus a warning), with the unscheduled-source staleness half still open, so D20 stays PARTIAL. 2026-10-27 — D20 corrected to PARTIAL (the §7.8 reduced-yield rule was not implemented), migration count refreshed to 15, ENG-022 resolution recorded (D32). 2026-10-25 — D9 evidence from ADR-0010 (2026-10-24), D19/AC-019 backup scripts and recorded restore drill.
**Baseline commit:** `31db910` (working tree clean except untracked `.freebuff/`)
**Authoritative specification:** `docs/SRS/JobHunter-v1.1-SRS.md`
**Method:** read-only inspection of the SRS, schema, migrations, routes, domain/application/infrastructure code, tests and docs. No SRS, schema or code was changed to produce this report. Nothing was executed against a real source or Telegram.

---

## 1. Which requirements govern

`JobHunter-v1.1-SRS.md` is authoritative. The two v1.0 files are 8–12 line pointers marked "SUPERSEDED, NOT authoritative" (commits `f810a8c`, `7bff4da`), so the earlier concern about three competing SRS files is **resolved, not drift**. `AGENTS.md` agrees.

One internal inconsistency remains inside v1.1: the Document Control row still says `Draft for owner approval` while the header says `Status: Implementation Baseline`. Cosmetic, but ENG-034 makes SRS amendments a versioned act, so the status line should be settled before v1.2.

---

## 2. What the implementation actually is

- **API:** Fastify 4 (not NestJS, which §2.5 and §7.2 name), one process, loopback-bound by default.
- **Worker:** separate Node.js process; PostgreSQL-backed `WorkTask` queue with `SKIP LOCKED` claiming, lease tokens and expiry reaping.
- **Database:** PostgreSQL, 15 versioned migrations, Prisma schema plus hand-written partial indexes.
- **Web:** server-rendered HTML, no client JavaScript, CSP `default-src 'none'`.
- **Telegram:** outbox → dispatcher → `sendMessage`, plain text, retry/backoff, 429 `retry_after`.
- **Sources:** 3 approved adapters — Ethiojobs, JobWebEthiopia, Effoysira (AC-001 met: 3, the SRS minimum of "3–5").
- **Matching:** deterministic, `MATCHER_VERSION = 1.0.0`, SRS weights exactly (25/30/15/15/5/5/5), UNKNOWN excluded and renormalised.
- **AI:** none. No `AiProvider`, no `NoopProvider`, no AI call site.

### Route inventory

| SRS route | Exists | Notes |
| --- | --- | --- |
| `/dashboard` | yes | best matches, high-confidence matches, notification status, source health |
| `/jobs`, `/jobs/:id` | yes | |
| `/matches` | yes | SRS requires it; detail route `/matches/:id` is an addition |
| `/profile` | yes | GET + POST, session + CSRF |
| `/settings` | yes | thin; links to Telegram |
| `/settings/telegram` | yes | GET + POST link flow |
| — | extra | `/` → `/dashboard`, `/login`, `/logout` (ADR-0009) |

| SRS API endpoint | Exists |
| --- | --- |
| `GET /api/jobs`, `/api/jobs/:id` | yes |
| `GET /api/matches`, `/api/matches/:id` | yes |
| `GET /api/profile`, `PUT /api/profile` | yes |
| `GET /api/notifications`, `POST /api/notifications/:id/feedback` | yes |
| `POST /api/telegram/link` | yes |
| `GET /api/sources`, `POST /api/sources/:id/run` | yes |
| — | extra: `GET /api/sources/:id`, `GET /api/sources/:id/runs` |

---

## 3. Product identity: the decision the SRS cannot make for you

The SRS is a **single-user** document: "Primary User: One seeded candidate" (§ header), "One seeded candidate owns one profile and one Telegram destination" (§2.2), registration deferred (§2.2), multi-user SaaS a non-goal (§1.7).

The implementation is **multi-candidate capable**: `users` is a table with no singleton constraint, and every row — profile, matches, notifications, Telegram link — is keyed by `userId`. What a caller can *ask* for is not a candidate: since ADR-0011 no route or page accepts a `userId`, and the one a handler acts on comes from the credential it presented. Several candidates are therefore several sign-ins (`npm run login -- --email …`), not several ids on one page; the candidate chooser that used to list them at `/login?userId=<id>` is gone, because a page that names stored ids is a page that hands out sessions for them. There is still no registration, invitation or admin UI, so operationally this remains one-person software with several seeded rows.

Classification: **intentional extension, not a defect** — the owner asked for a system that does not assume a single candidate. But it is currently undocumented as a scope change and it collides with §8.1/§8.2 (below).

**Proposed direction (needs owner confirmation):** keep "single tenant, N seeded candidates, no registration", record it in an ADR, and amend §1.7/§2.2 in a v1.2 SRS. Do not build registration to satisfy the SRS; do not narrow the model to satisfy the SRS either.

---

## 4. Drift register

Status: **MATCH** · **PARTIAL** · **MISSING** · **DIVERGENT** (implemented differently). Class: intentional / accidental / obsolete / unresolved. Risk: critical / high / medium / low.

### 4.1 Security and identity

| ID | SRS | Status | Evidence | Class | Risk |
| --- | --- | --- | --- | --- | --- |
| D1 | §8.1 "The seeded user shall be authenticated"; §8.2 "Ownership must be enforced server-side at the service layer"; ENG ownership intent | **MATCH** | Closed 2026-10-30 (ADR-0011; audit H2). A root `preHandler` decides who is asking before any route runs: `/api/*` needs a bearer credential the deployment signed or the browser's session, every non-public page needs a session, and handlers read the identity only from that principal. Ownership is enforced at the read (`FindMatchesForUser`, `findForUser`, `/matches/:id` answers a foreign row with the same 404 a missing one gets), and a caller that names `userId` anywhere is refused 400 rather than ignored. `Host` is allowlisted, mutating requests must be same-origin, and a non-loopback `API_HOST` refuses to boot without `API_ALLOW_EXTERNAL_BIND=true` and `API_ALLOWED_HOSTS`. §8.1's "passwords … if used" is read as permission, not requirement: the credential is a locally minted signed claim, which is unforgeable without `AUTH_SECRET`. **Open:** TLS on an opted-in external bind is still not implemented, so the clause "unless auth and TLS are explicitly enabled" is half-satisfied by refusing the bind outright. | resolved (was: audit H2) | low |
| D2 | §8.1 passwords "if used" | **MATCH** | Still no password, now by ADR-0011 §1's reading rather than ADR-0009 §2.3's: a credential is whatever is hard to forge and easy to check, and the operator chose the locally-minted one-time link. `AUTH_SECRET` is a required boot secret (≥32 bytes), and rotating it — which invalidates every outstanding link, token and session — is the only revocation mechanism. | intentional | low |
| D3 | §2.2 one candidate / §1.7 no multi-user SaaS | **DIVERGENT** | Multi-candidate data model, no registration; since ADR-0011 there is no candidate chooser, so N candidates are N local sign-ins rather than N ids on one page. See §3. | unresolved | medium |

### 4.2 Matching inputs

| ID | SRS | Status | Evidence | Class | Risk |
| --- | --- | --- | --- | --- | --- |
| D4 | §5.1 `JobSkill` entity; §4.6 Skills 30%; FR-009 "extract key fields"; FR-014 confidence | **MISSING** | No `JobSkill` model anywhere. `prisma-matchable-job-reader.ts` returns `skills: []` and `requiredExperience: null`, so `skillScore` is always `null` and 30% of the weight is permanently excluded; confidence is capped by that absence. Matcher-side ladder is implemented and tested but never fed. | intentional (ADR-0005 D3, sign-off gated) | high |
| D5 | §4.6 weights and UNKNOWN renormalisation | **MATCH** | `src/domain/matching/weights.ts` is exactly the SRS table; `score-match.ts` renormalises over known weights. | intentional | low |
| D6 | §5.6 `JobMatch(userId,jobId) UNIQUE` | **DIVERGENT** | Unique key is `(userId, jobId, matcherVersion, inputHash)` so re-scores keep history. Deliberate and documented in the schema. | intentional | low |
| D7 | FR-015 explainability | **MATCH** | Per-factor scores, evidence document, deterministic explanation, match page renders all of it. | intentional | low |

### 4.3 Collection, dedupe and lifecycle

| ID | SRS | Status | Evidence | Class | Risk |
| --- | --- | --- | --- | --- | --- |
| D8 | FR-008 "detect duplicates using multiple signals"; AC-005 | **PARTIAL** | Dedupe is **source-scoped**: `Job` is unique on `(sourceId, identityKey)`, and the schema comment states the same listing in two sources stays two Jobs. Cross-source duplicates are not detected. | intentional (ADR-0001) | high |
| D9 | FR-019 / Appendix A `NOT_FOUND`; AC-018 | **PARTIAL** | `ACTIVE/EXPIRED/REMOVED` implemented; since 2026-11-01 the presence sweep runs after **every** `SUCCEEDED` collection under `LIFECYCLE_V2` (ADR-0010 §8): a Job the newest run captured is restored on that evidence alone, retirement still needs a run that read the listing to the end or reached below the Job's publication date, and every move is fenced on the status the deciding pass read, so the presence and deadline policies cannot overwrite each other's determination. `NOT_FOUND` is never set (no dead-link probe). | intentional deferral (`NOT_FOUND` only) | medium |
| D10 | FR-006 "verify application targets" | **PARTIAL** | URLs are normalised and an application method is required for notification, but no URL is ever fetched to verify it resolves. | intentional (bundled with D9) | medium |
| D11 | FR-001/FR-002/FR-003, §7.7 pipeline | **MATCH** | Adapter registry, per-source exclusivity, SourceRun counters, unexpected-zero-result flag, isolation per source task. | intentional | low |
| D12 | §7.7 step 10 "schedule enrichment/matching work" | **MATCH** | `run-source-collection.ts:482` enqueues matching and records `enrichmentScheduled`. The schema comment claiming "no registered handler yet" is stale. | accidental (comment only) | low |

### 4.4 Notifications and feedback

| ID | SRS | Status | Evidence | Class | Risk |
| --- | --- | --- | --- | --- | --- |
| D13 | §3.2 Actions `VIEW \| SAVE \| REJECT \| APPLY / OPEN / COPY EMAIL`; AC-017 | **PARTIAL** | The message carries all §3.2 *content* items and the application path, but `telegram-notification-sender.ts:60` sends plain `sendMessage` with **no `reply_markup`**, so there are no buttons. Feedback exists only as `POST /api/notifications/:id/feedback`; the web UI shows notifications but has no feedback form. A Telegram-only user cannot classify an alert from the alert. | accidental/not built | high |
| D14 | §3.2 duplicate events; AC-016; ENG-027 | **MATCH** | Unique `(userId, jobId, notificationType, event)`; match + outbox in one transaction. | intentional | low |
| D15 | §3.2 429 handling | **MATCH** | Dispatcher honours `retry_after`; outbox retry/backoff; failure never deletes the match. | intentional | low |
| D16 | Appendix E material-change events | **MISSING** | Only `NEW_MATCH` is emitted; `MATERIAL_CHANGE` + field hash is not implemented. The SRS says "unless an explicitly supported material-change event occurs", so no false claim is made, but the Appendix E clarification is unimplemented. | intentional deferral | low |

### 4.5 AI

| ID | SRS | Status | Evidence | Class | Risk |
| --- | --- | --- | --- | --- | --- |
| D17 | §4.7, §3.6, FR-010, AC-012, M4 | **MISSING** | No provider, no port, no schema, no call site, no `AI_PROVIDER` reader. `.env.example` documents `AI_PROVIDER=noop` and nothing consumes it. AC-011 passes vacuously; AC-012 cannot be evaluated because there is nothing to fail. | intentional deferral (M4) | medium |
| D18 | §5.1 `AiAnalysisRequest`, `AiEvidence` | **MISSING** | Neither model exists. | intentional (depends on D17) | low |

### 4.6 Operations

| ID | SRS | Status | Evidence | Class | Risk |
| --- | --- | --- | --- | --- | --- |
| D19 | FR-021 "run scheduled database backups"; AC-019 "backup can be restored"; §5.1 `BackupRun` | **PARTIAL** | `scripts/backup.mjs` (validated custom-format dump; with `BACKUP_COPY_DIR` also a byte-verified, `pg_restore`-readable second copy outside the repository), `scripts/restore-drill.mjs` (disposable database; since 2026-10-30 also compares Prisma's migration ledger by name and checksum, requires it to cover this checkout's migrations, and runs `listSchedulable` against the restore), `scripts/prune-backups.mjs` (14 daily / 8 weekly, dry run unless `--apply`) and `scripts/install-backup-schedule.mjs` (prints the daily task; `--apply` registers it). The schema-aware drill passed 2026-10-30: 17/17 tables, 565/565 rows, 15 migrations, scheduler query answered; forcing the 13-migration archive through strict mode correctly fails on the two migrations it predates. Documented in `docs/engineering/backup-and-restore.md`. No `BackupRun` model (intentional, §7). **Still deployment steps:** the task is not installed and no encrypted off-machine copy exists — this host has one volume, at capacity — so AC-019 cannot be met by scripts alone. | deployment step | medium |
| D20 | FR-020 / §7.8 source metrics and drift detection | **PARTIAL** | Run counts, accepted/rejected, parse/HTTP failures, duration, `unexpectedZeroResults`, health status, dashboard source health — the metrics list is met. §7.8 "Drift detection" (`docs/SRS/JobHunter-v1.1-SRS.md:1264`) now has **both** of its cases: `classifyYieldDrift` (`src/domain/health/source-yield-drift.ts`, 2026-10-28) compares a clean run's parsed yield with the median of the source's last three SUCCEEDED catalogue-exhausted runs and makes the source `DEGRADED` (plus a `warn` log) when it falls below half a baseline of at least five, and zero is handled by `isUnexpectedZeroResult`. Capped, partial and failed runs are not judged. The second case — a source that stops being collected altogether — closed 2026-10-30: `classifySourceSilence` (`src/domain/health/source-silence.ts`) compares `lastSuccessfulRunAt` with twice the source's own `schedule` interval, the scheduler writes `DEGRADED` behind a fenced update and warns once, and the same verdict is derived per response on `/api/sources*` and the dashboard "Delivery" column, so a source whose scheduler never fires stops claiming to be healthy even while the collector is down. A source that has never succeeded, has no schedule, or has an unparseable schedule is reported as *not measurable* rather than silent. What keeps the row PARTIAL is the rest of §7.8, not drift detection: the funnel view (collected→…→notified) is not a page or a roll-up, notification metrics are only visible per row, and `jobsRejected` stays `0` by ADR-0001 §4 (no collection-time rejection rule exists). AI metrics N/A with D17. | accidental (yield rule never implemented until 2026-10-28; row previously claimed MATCH) | medium |
| D21 | AC-020 14-day precision | **MISSING** | No measurement tooling or log; feedback storage exists, so this is process, not code. | not started | high |

### 4.7 Architecture and engineering rules

| ID | SRS | Status | Evidence | Class | Risk |
| --- | --- | --- | --- | --- | --- |
| D22 | §2.5/§7.2 "Backend API: NestJS" | **DIVERGENT** | Fastify. `docs/architecture/architecture.md` is a **placeholder** ("Status: Placeholder"), so no ADR records the substitution. | accidental (undocumented) | medium |
| D23 | ENG-015 "dependency direction enforced by an automated check in continuous integration" | **MISSING** | Direction is respected in practice but nothing enforces it: no layering test, and **no CI configuration at all** (no `.github/`). | accidental | medium |
| D24 | ENG-020 versioned migrations; ENG-021 DB invariants guarded by tests | **MATCH** | 15 migrations; partial unique indexes covered by `tests/integration/partial-indexes.spec.ts`. | intentional | low |
| D25 | ENG-023/024/025/026 durable work | **MATCH** | SKIP LOCKED claim, per-claim lease token, attempt-on-claim, reaping, `FAILED`/`DEAD_LETTER` retained. | intentional | low |
| D26 | ENG-028 numeric units | **MATCH** | `Percent` and `Probability` are distinct branded types; DB uses exact `Decimal`. | intentional | low |
| D27 | ENG-031 failure tests | **PARTIAL** | Worker kill, SIGTERM, source timeout and zero-result are covered; AI timeout/invalid output cannot be (D17); dead-URL recovery cannot be (D9). | depends on D9/D17 | low |
| D28 | ENG-033 "verification evidence reported before merge" | **PARTIAL** | Done manually and consistently in this repo; no CI to enforce it. | process | low |
| D32 | ENG-022 "New timestamp columns use a timezone-aware type" | **MATCH** (for new columns) | `source_runs.oldestListingPublishedAt` is `timestamptz(3)` as of `20261024150000`, written as an explicit UTC instant; ADR-0010 §2.1 records the comparison against the still-naive `jobs.publishedAt` as `(publishedAt AT TIME ZONE 'UTC') > oldestListingPublishedAt` so the window boundary cannot move with the session zone. The conversion was **forward-only**: `20261024140000` created the column naive and had already been applied to `jobhunter_test`, so amending it would change a recorded checksum and break `migrate deploy`. Pre-existing naive columns (`publishedAt`, `createdAt`, …) are untouched — converting them rewrites data and is a separate decision. | resolved (was: audit M10) | low |

### 4.8 Data model

| ID | SRS | Status | Evidence |
| --- | --- | --- | --- |
| D29 | §5.1 entities present | **PARTIAL** | Present: User, CandidateProfile, CandidateSkill, TargetRole, LocationPreference, JobSource, SourceRun, RawJob, Job, JobMatch, NotificationOutbox, NotificationFeedback, SystemLog. Missing: **JobSkill, AiAnalysisRequest, AiEvidence**; `BackupRun` is deliberately omitted (D19 records backups as archives, not rows). WorkTask, TelegramLinkToken, TelegramDestination, NotificationOutbox.event are engineering additions (Appendix E covers WorkTask and the event key). |
| D30 | Appendix A `SalaryPeriod` | **DIVERGENT** | Implementation adds `OTHER`; the SRS allows HOUR/DAY/WEEK/MONTH/YEAR/UNKNOWN. Rendered as "period stated by the source". | intentional | low |
| D31 | §5.2 required Job columns | **MATCH** | All listed columns exist; additions (`identityKey`, `provenance`, `applicationDeadline`) are documented in the schema. | intentional | low |

---

## 5. Acceptance criteria scorecard

| AC | Verdict | Basis |
| --- | --- | --- |
| AC-001 3 sources | **PASS** | 3 adapters; live run recorded earlier |
| AC-002 isolation | **PASS (code + tests)** | per-source tasks; not re-run live in this pass |
| AC-003 traceability | **PASS** | `rawJobId` FK, identity key, raw rows never mutated downstream |
| AC-004 usable application path | **PASS** | eligibility gate requires an application method |
| AC-005 duplicates | **PARTIAL** | within-source only (D8) |
| AC-006 Ethiopian dates | **PASS** | deterministic conversion + UNKNOWN fixtures |
| AC-007 salary never fabricated | **PASS** | no numeric values for NEGOTIABLE/AS_PER_SCALE/UNKNOWN |
| AC-008 missing location UNKNOWN | **PASS** | |
| AC-009 matcher determinism | **PASS** | injected clock, versioned |
| AC-010 UNKNOWN ≠ negative | **PASS** | renormalised denominator |
| AC-011 AI off | **PASS (vacuous)** | no AI exists |
| AC-012 AI failure | **NOT VERIFIABLE** | nothing to fail (D17) |
| AC-013 heavy work outside API | **PASS** | separate worker |
| AC-014 restart recovery | **PASS** | kill test + lease reaping |
| AC-015 persistent outbox | **PASS** | |
| AC-016 no duplicate events | **PASS** | unique event key |
| AC-017 classify delivered alerts | **PARTIAL** | API + storage only; no button, no web form (D13) |
| AC-018 zero-result visibility | **PASS** | `unexpectedZeroResults` + dashboard |
| AC-019 backup restorable | **PARTIAL (was PASS)** | D19. The drill proves restore **and** schema currency: 2026-10-30 fresh run matched 17/17 tables, 565/565 rows, the migration ledger (names + checksums) and answered the scheduler's query. "Backup can be restored" is demonstrated; FR-021's *scheduled*, off-machine, encrypted copy is not, and this host has nowhere to put one — so the criterion cannot yet be met end to end |
| AC-020 14-day precision | **FAIL (not started)** | D21 |

---

## 6. Implemented but absent from the SRS

All are documented in schema comments or ADRs, so none is silent:

- `Job.identityKey`, `Job.provenance`, `Job.applicationDeadline`.
- `RawJob.contentHash`, `RawJob.lastSeenAt`, `RawJob.sourceRunId`.
- `SourceRun` counters and `enrichmentScheduled`.
- `WorkTask` (Appendix E), `TelegramLinkToken`, `TelegramDestination`.
- `NotificationOutbox.event` / `jobMatchId` (Appendix E).
- `JobMatch.profileVersion`, `inputHash`, `scoredAt`.
- `SalaryPeriod.OTHER`; `RemotePreference`, `RelocationPreference`, `HealthStatus`, `SourceRunStatus`, `SourceRunTrigger` value sets (ADR-0003/0005).
- `/login`, `/logout`, `/matches/:id`, `GET /api/sources/:id`, `GET /api/sources/:id/runs`.
- Session/CSRF layer (ADR-0009), and the signed sign-in link and API credential that replaced its `?userId=` login (ADR-0011).

---

## 7. Smallest correction per confirmed issue

Ordered by cost, not importance; each is independently reviewable.

| Issue | Smallest correction |
| --- | --- |
| D12 stale comment | Fix the `SourceRun.enrichmentScheduled` comment. One line. |
| D22 Fastify vs NestJS | One ADR: "Fastify is the API framework" (framework substitution), with the SRS §2.5 line flagged for v1.2. No code change. |
| D23 no layering check | One test that imports every domain file and asserts it imports no `@infrastructure`/`@adapters`/`@app`, plus the reverse for infrastructure. No CI account needed. |
| D30 `OTHER` | Either remove `OTHER` or add it to a v1.2 Appendix A note; it is already rendered explicitly. |
| D9 `NOT_FOUND` | The presence sweep is wired (ADR-0010). Add `NOT_FOUND` only with an ADR for the dead-link probe; `REMOVED` needs no further work. |
| D13 feedback actions | Ship `reply_markup` buttons **only if** callback handling is added; otherwise state plainly that feedback is web/API-only and stop calling AC-017 met. |
| D8 cross-source dedupe | Write the ADR that decides whether cross-source merging is in scope; do not change the key before that decision. |
| D17/D18 AI | Leave deferred. The milestone is M4; nothing else depends on it. |
| D19 backup | **Scripts are as strong as they can be without a second machine** — 2026-10-25 added the dump and drill; 2026-10-30 made the drill schema-aware (migration ledger + the scheduler's query), added a byte-verified `BACKUP_COPY_DIR` copy, `backup:prune` retention and `backup:schedule`. What is left is not code: register the task (`npm run backup:schedule -- --apply`), point `BACKUP_COPY_DIR` at an encrypted destination on another host or volume, and drill that copy. No `BackupRun` model is needed for a single-operator MVP. |
| D21 precision | Spreadsheet, not code. |
| D20 yield drift (§7.8) | **Both drift cases are done.** 2026-10-28: `classifyYieldDrift` raises `DEGRADED` and logs a warning when a clean run parses less than half the median of the last three clean runs (baseline of at least five records). 2026-10-30: `classifySourceSilence` raises `DEGRADED` and warns once when a scheduled source's *last success* ages past twice its own declared interval — evaluated by the scheduler for the durable signal and derived on every `/api/sources*` and dashboard read for the signal that survives the collector being down. Both thresholds are documented engineering defaults (`0.5`, `5`, `3`; multiplier `2`), not SRS values, and are the owner's to tune. What §7.8 still lacks is the funnel roll-up and notification-metric aggregation, which is L8, not drift detection. The row claimed MATCH until 2026-10-27, which overstated §7.8. |
| D1 API auth | **Done 2026-10-30.** The boundary was decided and implemented: identity comes from a signed credential or the session and never from the request (ADR-0011). Remaining: TLS if the API is ever bound outside loopback. |

---

## 8. Decisions only the owner can make

1. **Trust boundary.** **Answered 2026-10-30:** the API authenticates. `/api/*` answers only through a principal (a bearer credential from `npm run token`, or the browser's session), the browser gets that session only by opening a one-time link `npm run login` minted locally, and a non-loopback bind refuses to start without two explicit opt-ins. ADR-0011 records the reasoning; §8.1 needs no amendment, and §3.4's "no authentication" reading is what changed. The open sub-decision is the one ADR-0011 §6 leaves: whether to install TLS before `API_ALLOW_EXTERNAL_BIND` is ever set.
2. **Candidate model.** Confirm "single tenant, N seeded candidates, no registration", so §2.2/§1.7 can be amended once rather than repeatedly.
3. **Cross-source dedupe.** In scope for the MVP or explicitly out? D8 stays open until this is answered.
4. **NestJS.** The SRS names it; the code uses Fastify. Record the substitution, or schedule a rewrite (not recommended — it buys nothing here).

---

## 9. Limits of this report

- Not executed in this pass: live source collection, live Telegram delivery. Restore drills **were**
  executed — on 2026-10-25 (D19) and again on 2026-10-30 against the schema-aware drill. Statuses for
  AC-001/AC-002/AC-015 rely on earlier recorded runs plus the current code and tests; AC-019 is
  backed by the drill records in `docs/engineering/backup-and-restore.md`, and is PARTIAL because no
  off-machine encrypted copy has been drilled.
- The SRS is internally inconsistent in two places: Document Control status (`Draft`) vs header (`Implementation Baseline`), and §8.1 "seeded user shall be authenticated" vs §3.4 defining endpoints with no authentication. Both are recorded here rather than resolved.
- No claim is made that the drift register is exhaustive; it covers every requirement with a concrete implementation counterpart.
- The 2026-10-27 refresh: D32 and the migration count were checked against `prisma migrate status`
  on `jobhunter` (15 applied, schema up to date) and live 200 responses from `/dashboard`,
  `/api/jobs`, `/api/matches` and `/api/sources`.
- The 2026-10-28 refresh: D20's yield half was verified by executing the rule, not by reading it —
  `tests/unit/yield-drift-policy.spec.ts`, `tests/unit/source-health-policy.spec.ts` and the
  `reduced-yield drift` cases in `tests/integration/source-health.spec.ts` run against the real
  database and assert both the `DEGRADED` verdict and the warning line. The thresholds (half of a
  median of three, minimum five records) are engineering defaults and are not in the SRS.
