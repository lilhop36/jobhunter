# SRS ↔ Implementation Drift Report

**Date:** 2026-10-23
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
- **Database:** PostgreSQL, 12 versioned migrations, Prisma schema plus hand-written partial indexes.
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

The implementation is **multi-candidate capable**: `users` is a table with no singleton constraint, the match/notification/profile routes accept `?userId=`, the web layer has a candidate chooser at `/login?userId=<id>` (ADR-0009), and `/profile` writes whichever candidate the session names. There is no registration, invitation or admin UI, so operationally it is still one-person software with several seeded rows.

Classification: **intentional extension, not a defect** — the owner asked for a system that does not assume a single candidate. But it is currently undocumented as a scope change and it collides with §8.1/§8.2 (below).

**Proposed direction (needs owner confirmation):** keep "single tenant, N seeded candidates, no registration", record it in an ADR, and amend §1.7/§2.2 in a v1.2 SRS. Do not build registration to satisfy the SRS; do not narrow the model to satisfy the SRS either.

---

## 4. Drift register

Status: **MATCH** · **PARTIAL** · **MISSING** · **DIVERGENT** (implemented differently). Class: intentional / accidental / obsolete / unresolved. Risk: critical / high / medium / low.

### 4.1 Security and identity

| ID | SRS | Status | Evidence | Class | Risk |
| --- | --- | --- | --- | --- | --- |
| D1 | §8.1 "The seeded user shall be authenticated"; §8.2 "Ownership must be enforced server-side at the service layer"; ENG ownership intent | **PARTIAL** | Web pages have a session cookie (ADR-0009), but the **JSON API has no authentication at all**; routes trust `?userId=` and `:id` (`apps/api/routes/notifications.ts:27-29` says so explicitly). Any local caller can read or overwrite any candidate's profile and classify any notification. Mitigation is loopback binding only. | unresolved | high |
| D2 | §8.1 passwords "if used" | **MATCH** | No password, so the conditional clause does not apply; ADR-0009 chose session-without-password and was accepted. | intentional | low |
| D3 | §2.2 one candidate / §1.7 no multi-user SaaS | **DIVERGENT** | Multi-candidate data model + chooser, no registration; see §3. | unresolved | medium |

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
| D9 | FR-019 / Appendix A `NOT_FOUND`; AC-018 | **PARTIAL** | `ACTIVE/EXPIRED/REMOVED` implemented; `NOT_FOUND` is never set (no dead-link probe). `SweepSourceLifecycle` exists but is **not wired** into the worker, so `REMOVED` is also unreachable in production. | intentional deferral | medium |
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
| D19 | FR-021 "run scheduled database backups"; AC-019 "backup can be restored"; §5.1 `BackupRun` | **MISSING** | No `BackupRun` model, no backup script, no restore drill. | not built | high |
| D20 | FR-020 / §7.8 source metrics and drift detection | **MATCH** | Run counts, accepted/rejected, parse/HTTP failures, duration, `unexpectedZeroResults`, health status, dashboard source health. AI metrics N/A with D17. Funnel view (collected→…→notified) is not a page. | intentional | low |
| D21 | AC-020 14-day precision | **MISSING** | No measurement tooling or log; feedback storage exists, so this is process, not code. | not started | high |

### 4.7 Architecture and engineering rules

| ID | SRS | Status | Evidence | Class | Risk |
| --- | --- | --- | --- | --- | --- |
| D22 | §2.5/§7.2 "Backend API: NestJS" | **DIVERGENT** | Fastify. `docs/architecture/architecture.md` is a **placeholder** ("Status: Placeholder"), so no ADR records the substitution. | accidental (undocumented) | medium |
| D23 | ENG-015 "dependency direction enforced by an automated check in continuous integration" | **MISSING** | Direction is respected in practice but nothing enforces it: no layering test, and **no CI configuration at all** (no `.github/`). | accidental | medium |
| D24 | ENG-020 versioned migrations; ENG-021 DB invariants guarded by tests | **MATCH** | 12 migrations; partial unique indexes covered by `tests/integration/partial-indexes.spec.ts`. | intentional | low |
| D25 | ENG-023/024/025/026 durable work | **MATCH** | SKIP LOCKED claim, per-claim lease token, attempt-on-claim, reaping, `FAILED`/`DEAD_LETTER` retained. | intentional | low |
| D26 | ENG-028 numeric units | **MATCH** | `Percent` and `Probability` are distinct branded types; DB uses exact `Decimal`. | intentional | low |
| D27 | ENG-031 failure tests | **PARTIAL** | Worker kill, SIGTERM, source timeout and zero-result are covered; AI timeout/invalid output cannot be (D17); dead-URL recovery cannot be (D9). | depends on D9/D17 | low |
| D28 | ENG-033 "verification evidence reported before merge" | **PARTIAL** | Done manually and consistently in this repo; no CI to enforce it. | process | low |

### 4.8 Data model

| ID | SRS | Status | Evidence |
| --- | --- | --- | --- |
| D29 | §5.1 entities present | **PARTIAL** | Present: User, CandidateProfile, CandidateSkill, TargetRole, LocationPreference, JobSource, SourceRun, RawJob, Job, JobMatch, NotificationOutbox, NotificationFeedback, SystemLog. Missing: **JobSkill, AiAnalysisRequest, AiEvidence, BackupRun**. WorkTask, TelegramLinkToken, TelegramDestination, NotificationOutbox.event are engineering additions (Appendix E covers WorkTask and the event key). |
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
| AC-019 backup restorable | **FAIL (not built)** | D19 |
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
- Session/CSRF layer (ADR-0009).

---

## 7. Smallest correction per confirmed issue

Ordered by cost, not importance; each is independently reviewable.

| Issue | Smallest correction |
| --- | --- |
| D12 stale comment | Fix the `SourceRun.enrichmentScheduled` comment. One line. |
| D22 Fastify vs NestJS | One ADR: "Fastify is the API framework" (framework substitution), with the SRS §2.5 line flagged for v1.2. No code change. |
| D23 no layering check | One test that imports every domain file and asserts it imports no `@infrastructure`/`@adapters`/`@app`, plus the reverse for infrastructure. No CI account needed. |
| D30 `OTHER` | Either remove `OTHER` or add it to a v1.2 Appendix A note; it is already rendered explicitly. |
| D9 `REMOVED`/`NOT_FOUND` | Wire `SweepSourceLifecycle` behind an explicit ADR (presence sweep has the same HTTP-budget question as the dead-link probe); add `NOT_FOUND` only with that ADR. |
| D13 feedback actions | Ship `reply_markup` buttons **only if** callback handling is added; otherwise state plainly that feedback is web/API-only and stop calling AC-017 met. |
| D8 cross-source dedupe | Write the ADR that decides whether cross-source merging is in scope; do not change the key before that decision. |
| D17/D18 AI | Leave deferred. The milestone is M4; nothing else depends on it. |
| D19 backup | One `scripts/backup.mjs` (`pg_dump` to file) + one restore drill in a disposable database, recorded. No `BackupRun` model needed for a single-operator MVP. |
| D21 precision | Spreadsheet, not code. |
| D1 API auth | Decide the trust boundary first (see §8); the code change follows the decision. |

---

## 8. Decisions only the owner can make

1. **Trust boundary.** Is the API loopback-only forever (then §8.1 must be amended to say so), or must it authenticate (then the session layer extends to `/api/*` and ownership checks become mandatory)? Everything about D1/D3 follows from this.
2. **Candidate model.** Confirm "single tenant, N seeded candidates, no registration", so §2.2/§1.7 can be amended once rather than repeatedly.
3. **Cross-source dedupe.** In scope for the MVP or explicitly out? D8 stays open until this is answered.
4. **NestJS.** The SRS names it; the code uses Fastify. Record the substitution, or schedule a rewrite (not recommended — it buys nothing here).

---

## 9. Limits of this report

- Not executed in this pass: live source collection, live Telegram delivery, a restore drill. Statuses for AC-001/AC-002/AC-015 rely on earlier recorded runs plus the current code and tests.
- The SRS is internally inconsistent in two places: Document Control status (`Draft`) vs header (`Implementation Baseline`), and §8.1 "seeded user shall be authenticated" vs §3.4 defining endpoints with no authentication. Both are recorded here rather than resolved.
- No claim is made that the drift register is exhaustive; it covers every requirement with a concrete implementation counterpart.
