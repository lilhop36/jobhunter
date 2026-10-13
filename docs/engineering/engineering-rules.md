# JobHunter Engineering Rules

**Status: PROPOSED — awaiting architect review.**

- Requirements source of truth (per `AGENTS.md`): [`docs/SRS/JobHunter-v1.1-SRS.md`](../SRS/JobHunter-v1.1-SRS.md)
- Concise repository entry point: [`AGENTS.md`](../../AGENTS.md)
- Scope: enforceable engineering policy for JobHunter (product v1.0, SRS v1.1). This document **elaborates** the SRS;
  it does not replace it.

## How to read this document

- Every rule is normative (**MUST** / **MUST NOT**).
- Every rule carries a **Basis** line: an SRS section (`§`), a tracked acceptance criterion (`AC-nnn`), Appendix C
  (Definition of Done), or the marker **`[Engineering decision]`**.
- `[Engineering decision]` marks a rule that is **not** an explicit SRS requirement. It operationalizes the SRS and
  **must not contradict it**. Changing one is an engineering change; changing an SRS requirement is a requirements
  change requiring architect approval.
- Where this document and the SRS disagree, **the SRS wins**.

### Status of the cited references (important)

- The canonical SRS is **v1.1** (`docs/SRS/JobHunter-v1.1-SRS.md`). It supersedes v1.0 and, per its Document Control,
  removed or changed **no** v1.0 requirement.
- **§14 Engineering Rules** is populated in v1.1 with **`ENG-001`–`ENG-034`** (§14.1–§14.7). Those are the SRS's own
  binding rules and are the traceability target for the `ER-nn` rules below — see
  **Traceability to SRS Engineering Rules** at the end.
- **§10.5 Acceptance Criteria** holds the `AC-001`–`AC-020` table; `AC-nnn` references below point at it. §12 and §13
  are likewise populated in v1.1.
- The identifiers below (`ER-nn`) belong to this document and deliberately do not reuse the SRS `ENG-nn` numbering.
- The earlier v1.0 encoding defect is resolved: both v1.0 markdown files are now non-authoritative pointers to v1.1.

---

## 1. Evidence, provenance, and data fidelity

**ER-01 — Raw-evidence traceability.** Every accepted `Job` must be traceable to the `RawJob` evidence it was
derived from, and raw source evidence must remain inspectable.
_Basis: §4.3, §5.4, AC-003; Appendix C._

**ER-02 — Provenance must remain distinguishable.** Source-provided, deterministic, and AI-derived values must be
storable and distinguishable; important values retain evidence sufficient for debugging and reprocessing.
_Basis: §3.1 (Provenance), §5.4, AC-003; Appendix B.4._

**ER-03 — Normalize before matching.** Collected jobs must be normalized (URL, text, location, salary, dates)
before they participate in matching.
_Basis: §4.3; Appendix C._

**ER-04 — Never fabricate job facts.** The system must never invent or infer-and-persist employer, salary, location,
deadline, employment type, required skill, or application method.
_Basis: §4.7 (Prohibitions), §8.7, AC-007._

**ER-05 — `UNKNOWN` is a valid state.** Missing evidence must not be coerced to `false` or treated as negative
evidence.
_Basis: §2.3, §4.6 (UNKNOWN rule), AC-010._

**ER-06 — Non-numeric salaries never become numbers.** `NEGOTIABLE`, `AS_PER_SCALE`, `NOT_DISCLOSED`, and `UNKNOWN`
salary must never yield a fabricated numeric amount.
_Basis: §4.6 (Salary), AC-007._

**ER-07 — Ethiopian dates: explicit signal, deterministic, never guessed.** Conversion happens only on an explicit
calendar signal, is deterministic and versioned, records its conversion method, and yields `UNKNOWN` on uncertainty.
Date parsing must not throw on malformed input.
_Basis: §5.5, §4.3, AC-006; Appendix B.2._

**ER-08 — Location stays inside the Appendix A enum.** Location must use only the `LocationCategory` values; a
missing location remains `UNKNOWN`; remote/onsite status is modelled separately from the location category.
_Basis: §5.5, Appendix A, AC-008._

**ER-09 — Deterministic description-quality classification.** Descriptions are classified as sufficient / partial /
unusable by configurable deterministic checks. Unusable descriptions are excluded from matching and notification but
retained as evidence with metrics.
_Basis: §3.5, §4.3, §7.7; Appendix C._

**ER-10 — Usable application target before notification.** Application methods and targets are normalized and
verified; a job is not notified without a usable application path unless the notification policy explicitly permits
informational listings.
_Basis: §3.5, §4.4, §7.7, AC-004._

## 2. Deterministic matching, scoring, and confidence

**ER-11 — Matching is deterministic.** Identical structured input together with the same `matcherVersion` must
produce identical match output.
_Basis: §4.6, §6.7, AC-009._

**ER-12 — Matcher versioning.** Every stored match records `matcherVersion`. Any change to weights, thresholds, or
scoring logic requires a new version.
_Basis: §4.6 (Versioning), §6.3; Appendix B.3._

**ER-13 — Score is not confidence.** Confidence measures evidence completeness and extraction certainty and must not
be treated as (or substituted for) a relevance score.
_Basis: §2.3, §4.6 (Confidence)._

**ER-14 — `UNKNOWN` factors are excluded, not failed.** A factor with unknown evidence may be excluded from the
denominator with the known weights renormalized, and confidence/evidence completeness must decrease.
_Basis: §4.6 (UNKNOWN rule), AC-010._

**ER-15 — Salary scoring rules.** Known salary may score against salary preference; non-numeric salary types are
normally excluded from the salary denominator unless the candidate explicitly requires disclosed salary.
_Basis: §4.6 (Salary)._

**ER-16 — Remote preference direction.** Remote preference positively affects remote opportunities when remote is
preferred/required, and penalizes or rejects onsite jobs only when onsite is excluded.
_Basis: §4.6 (Remote)._

**ER-17 — Explainability.** Match decisions must be explainable: persist score, confidence, factor breakdown,
matched/missing/uncertain evidence, and `matcherVersion`.
_Basis: §3.1 (Match detail), §4.6; Appendix B.3._

**ER-18 — Scoring changes are validated, not invented.** Weights are a versioned hypothesis evaluated against real
notifications; no arbitrary precision/score target is adopted before a measured baseline exists.
_Basis: §4.6 (Initial weights), §10.4._

## 3. AI boundaries

**ER-19 — AI is advisory.** AI produces evidence only; it is never the authoritative source of job facts and never
makes the final decision.
_Basis: §2.3, §4.7, §8.7._

**ER-20 — AI runs only on explicit triggers.** AI is invoked only when a defined trigger applies (no skills despite
substantial description, low role confidence, ambiguous remote/location, ambiguous seniority, critical field
`UNKNOWN`, difficult-to-structure recoverable description).
_Basis: §4.7 (Explicit triggers)._

**ER-21 — AI output is validated.** AI output is parsed and schema-validated before use; invalid output becomes a
typed AI failure and is never accepted as fact.
_Basis: §4.7 (Structured output), §3.6; Appendix A (AIStatus), Appendix B.4._

**ER-22 — AI never silently overwrites stronger evidence.** AI-derived values must not overwrite stronger
source/deterministic evidence.
_Basis: §4.7 (Prohibitions), §8.7._

**ER-23 — AI never drives notification alone.** A job is not notified solely because AI judged it good.
_Basis: §4.7 (Prohibitions), §8.7._

**ER-24 — Source content is untrusted data.** Job descriptions and other external content are never treated as
instructions; prompt boundaries must explicitly identify source content as data.
_Basis: §4.7 (Prompt injection), §8.6._

**ER-25 — External AI is off by default.** External providers require explicit configuration and documented data
handling; private candidate data must not be transmitted externally without explicit configuration/consent.
_Basis: §8.4, §4.7 (Prohibitions)._

**ER-26 — No hard AI dependency.** The full pipeline operates with `AI_PROVIDER=noop`; AI timeouts/invalid output
fall back safely and never stop the pipeline.
_Basis: §6.8, §4.7; AC-011, AC-012; Appendix C._

**ER-27 — AI runs are bounded and recorded.** AI calls honor a configured timeout and per-run cap; provider, model,
schema version, prompt version, confidence, evidence, and status are recorded with AI evidence.
_Basis: §4.7 (Limits, AI evidence); Appendix B.4._

## 4. Acquisition, source ethics, and adapters

**ER-28 — HTTP-first.** HTTP/API/RSS/static parsing is attempted before browser automation; Playwright is a last
resort for genuinely client-rendered sources.
_Basis: §3.5, §7.7 (HTTP-first)._

**ER-29 — Source ethics.** The system must not bypass authentication, CAPTCHA, access controls, anti-bot
mechanisms, or source restrictions; rate limits and source rules must be respected.
_Basis: §2.6, §3.5, §7.7 (Source ethics)._

**ER-30 — Adapter isolation.** Source-specific logic lives behind `JobSourceAdapter`; no source-specific behavior
may contaminate the canonical domain model.
_Basis: §3.5, §6.3, §7.7 (Adapter contract)._

**ER-31 — Fixed ingestion sequence.** Collection follows: acquire permitted content → apply rate limits → create
`SourceRun` → persist `RawJob` → normalize → extract → validate description/application target → deduplicate →
persist `Job` → schedule enrichment/matching → complete `SourceRun` with counts and errors.
_Basis: §7.7 (Collection sequence)._

**ER-32 — Source isolation.** One source's failure must not stop collection for other sources.
_Basis: §4.2, §6.2, AC-002; Appendix C._

**ER-33 — Source-level exclusivity.** Source collection requires source-level exclusivity; a manual run against an
already-active source returns a `SOURCE_RUN_ACTIVE` conflict instead of starting concurrent work.
_Basis: §7.5, §3.4._

**ER-34 — Legitimate, maintainable sources only.** A source may be enabled only when legitimate access is stable
and maintainable; popularity alone is not justification.
_Basis: §5.5 (Local channels)._

## 5. Execution model and durable work

**ER-35 — Separate processes.** NestJS API and heavy background processing run as separate processes; collection,
parsing, and AI work must not execute in the API request path.
_Basis: §6.1, §7.2, AC-013; Appendix C._

**ER-36 — Responsibility split.** The API handles reads, profile changes, feedback, Telegram linking, operational
commands, and source-status reads; the worker handles collection, health checks, normalization, extraction, AI
enrichment, deduplication, matching, lifecycle sweeps, notification dispatch, retries/recovery, and backup
orchestration where appropriate.
_Basis: §7.2, §7.3, §7.4._

**ER-37 — Durable work.** Long-running work has persistent state; process death must not make an operation
permanently invisible or impossible to retry.
_Basis: §7.5, §6.2, AC-014; Appendix C._

**ER-38 — Atomic claiming.** Task claiming is atomic using database-safe mechanisms (row locks, `SKIP LOCKED`,
advisory locks, or equivalent).
_Basis: §7.5._

**ER-39 — Bounded, observable retries.** Retries are bounded and observable; permanent failures are retained for
diagnosis.
_Basis: §6.2, §7.6._

**ER-40 — Catch-up on startup.** After downtime, the next worker startup must determine whether a missed scheduled
operation should be executed.
_Basis: §7.6._

**ER-41 — Outbox + Telegram retry.** Notification delivery state is persisted in an outbox; Telegram failures and
429 responses trigger persistent retry/backoff without deleting the underlying match.
_Basis: §3.2, §4.8, AC-015; Appendix C._

**ER-42 — No repeated equivalent notifications.** The same qualifying job event is not delivered repeatedly unless
an explicitly supported material-change event occurs.
_Basis: §3.2, §4.8, AC-016._

**ER-43 — Feedback is recorded.** The system records relevant / not relevant / unsure feedback for delivered
alerts.
_Basis: §4.8, AC-017; Appendix C._

## 6. Persistence, migrations, and integrity

**ER-44 — PostgreSQL is canonical.** PostgreSQL is the canonical v1.0 datastore.
_Basis: §2.5, §3.7, §5.6._

**ER-45 — Integrity primitives.** Persistence uses foreign keys, unique constraints, indexes, transactions, and
explicit lifecycle states.
_Basis: §5.3, §3.7._

**ER-46 — Required uniqueness.** Schema enforces the required uniqueness, including `JobMatch(userId, jobId)` and
`CandidateSkill(candidateProfileId, canonicalSkill)`.
_Basis: §5.6._

**ER-47 — Versioned migrations.** Schema changes use versioned migrations; destructive migrations require a
verified backup.
_Basis: §5.7; Appendix C._

## 7. Observability, health, drift, and recovery

**ER-48 — Source metrics.** Track run count, success/failure, jobs discovered/accepted, parse failures, HTTP
failures, duration, and unexpected zero results.
_Basis: §7.8 (Source metrics)._

**ER-49 — Funnel and AI/notification metrics.** Track the pipeline funnel (collected → parsed → valid → unique →
active → matched → notified) and AI and notification metrics as specified.
_Basis: §7.8._

**ER-50 — Drift warning.** A source that suddenly produces zero jobs or a sharply reduced extraction yield must
produce an operator-visible warning.
_Basis: §7.8, AC-018; Appendix C._

**ER-51 — Backup and restore.** Scheduled database backups run and restore capability is verified.
_Basis: §4.9, AC-019; Appendix C._

**ER-52 — State survives transient failures.** Notification/match state is preserved across transient Telegram
failures.
_Basis: §4.9, §4.8._

## 8. Security and privacy

**ER-53 — Authenticated seeded user.** The seeded user is authenticated; passwords, if used, use a modern
password-hashing algorithm.
_Basis: §8.1._

**ER-54 — Server-side ownership.** Ownership is enforced server-side at the service layer; `userId` fields are
retained for multi-user readiness.
_Basis: §8.2, §2.2._

**ER-55 — Secret management.** Database credentials, Telegram secrets, AI credentials, JWT/session secrets, and
other sensitive configuration are environment/secret-managed and never committed.
_Basis: §8.3._

**ER-56 — Log hygiene.** Logs must not contain passwords, tokens, Telegram secrets, or private candidate content.
_Basis: §8.5._

**ER-57 — Untrusted external content.** External source content is untrusted and must never be executed.
_Basis: §8.6._

**ER-58 — Telegram linking token.** Linking uses a secure short-lived deep-link token that does not encode private
profile data.
_Basis: §3.2._

## 9. Testing and verification

**ER-59 — Automated verification required.** Every meaningful behavior has automated verification; no behavior is
claimed complete on the basis that it compiles.
_Basis: §9.1; `[Engineering decision]` for the "no compile-only completion" clause._

**ER-60 — Unit coverage.** Unit tests cover URL normalization, salary parsing, Ethiopian calendar conversion,
location classification, skill/role extraction, deduplication, matcher calculations, `UNKNOWN` behavior, AI schema
validation, notification eligibility, and Telegram retry/backoff.
_Basis: §9.1._

**ER-61 — Integration coverage.** Integration tests exercise Source → `RawJob` → `Job` → Match → Outbox → Telegram
dispatch/feedback against real PostgreSQL.
_Basis: §9.2._

**ER-62 — Real-data fixtures.** Representative fixtures are maintained for every source, including clean,
malformed, duplicate, missing-field, Ethiopian-date, salary-ambiguous, and dead-link cases.
_Basis: §9.3._

**ER-63 — Determinism test.** A test asserts identical input + `matcherVersion` produces identical output.
_Basis: §9.4, AC-009._

**ER-64 — Failure tests.** Simulate worker restart, AI timeout, invalid AI JSON, source timeout, zero-result
source, Telegram 429, dead URL, and database contention.
_Basis: §9.5._

**ER-65 — Regression discipline.** Changes to adapters, extraction logic, matcher rules, AI schemas/prompts, and
notification eligibility preserve associated fixtures and acceptance tests, or update them deliberately with
traceable version changes. Tests are never deleted or weakened merely to make the suite pass.
_Basis: §9.6; `[Engineering decision]` for the "never weakened to pass" clause._

**ER-66 — Definition of Done.** Release requires Appendix C to hold (clean migration, ≥3 real sources, inspectable
raw evidence, tested normalization/dedup, passing Ethiopian-date/salary fixtures, deterministic versioned matcher,
tested `UNKNOWN` behavior, AI disablable and failure-safe, separate API/worker, persistent recoverable work, outbox
Telegram, recorded feedback, drift detection, tested backup restore, 14-day validation, measured Notification
Precision).
_Basis: Appendix C, §10.1, §10.2; AC-001…AC-020._

## 10. Architecture boundaries (engineering decisions)

**ER-67 — I/O-free domain.** Domain code is free of I/O and framework dependencies (no Prisma, HTTP, filesystem);
clock and randomness are injected.
_Basis: `[Engineering decision]`._

**ER-68 — Persistence behind ports.** Prisma access is confined to infrastructure implementations behind port
interfaces; domain and application layers do not import Prisma.
_Basis: `[Engineering decision]`._

**ER-69 — Explicit ports.** External capabilities are expressed as explicit interfaces (e.g. `JobSourceAdapter`,
repositories, clock, logger) rather than concrete infrastructure types.
_Basis: `[Engineering decision]`; §3.5, §7.7 define the adapter contract._

**ER-70 — Mechanically enforced boundaries.** Layer boundaries are enforced by module layout/lint rules, not
convention alone.
_Basis: `[Engineering decision]`._

**ER-71 — No unjustified infrastructure.** Infrastructure is introduced only against a measured need;
Redis/BullMQ, vector ranking, and paid AI dependencies are deferred.
_Basis: §2.7, §6.4; `[Engineering decision]` for the enforcement mechanism._

**ER-72 — Graceful degradation is a first-class requirement.** AI, a source, or Telegram may fail without
destroying the pipeline.
_Basis: §2.3, §6.2._

---

## Traceability to SRS Engineering Rules (v1.1)

The v1.1 SRS defines binding engineering rules **`ENG-001`–`ENG-034`** in §14. The rules in this document elaborate
those requirements. The table maps each `ER-nn` to the SRS rule(s) it most directly operationalizes. `—` means the
rule elaborates SRS prose or an acceptance criterion without a single matching `ENG-nn`; the rule's own **Basis** line
names the source. This mapping is a traceability aid; **where the two disagree, the SRS wins.**

| ER | Topic | SRS rule(s) |
| --- | --- | --- |
| ER-01 | Raw-evidence traceability | ENG-002 |
| ER-02 | Provenance distinguishable | ENG-003 |
| ER-03 | Normalize before matching | — |
| ER-04 | Never fabricate job facts | ENG-001 |
| ER-05 | `UNKNOWN` is a valid state | ENG-001 |
| ER-06 | Non-numeric salaries never become numbers | ENG-001, ENG-006 |
| ER-07 | Ethiopian dates: explicit signal, deterministic | ENG-004, ENG-012, ENG-013 |
| ER-08 | Location stays inside the Appendix A enum | — |
| ER-09 | Description-quality classification | — |
| ER-10 | Usable application target before notification | — |
| ER-11 | Matching is deterministic | ENG-012 |
| ER-12 | Matcher versioning | ENG-013 |
| ER-13 | Score is not confidence | ENG-028 |
| ER-14 | `UNKNOWN` factors excluded, not failed | ENG-001 |
| ER-15 | Salary scoring rules | — |
| ER-16 | Remote preference direction | — |
| ER-17 | Explainability | — |
| ER-18 | Scoring changes are validated, not invented | ENG-014 |
| ER-19 | AI is advisory | ENG-007 |
| ER-20 | AI runs only on explicit triggers | — |
| ER-21 | AI output is validated | ENG-009 |
| ER-22 | AI never silently overwrites stronger evidence | — |
| ER-23 | AI never drives notification alone | ENG-007 |
| ER-24 | Source content is untrusted data | ENG-010 |
| ER-25 | External AI is off by default | ENG-011 |
| ER-26 | No hard AI dependency | ENG-008 |
| ER-27 | AI runs are bounded and recorded | ENG-003 |
| ER-28 | HTTP-first | ENG-019 |
| ER-29 | Source ethics | ENG-019 |
| ER-30 | Adapter isolation | ENG-016 |
| ER-31 | Fixed ingestion sequence | — |
| ER-32 | Source isolation | — |
| ER-33 | Source-level exclusivity | ENG-025 |
| ER-34 | Legitimate, maintainable sources only | ENG-019 |
| ER-35 | Separate processes | ENG-017 |
| ER-36 | Responsibility split | ENG-017 |
| ER-37 | Durable work | ENG-023 |
| ER-38 | Atomic claiming | ENG-023 |
| ER-39 | Bounded, observable retries | ENG-024, ENG-026 |
| ER-40 | Catch-up on startup | ENG-025 |
| ER-41 | Outbox + Telegram retry | ENG-027 |
| ER-42 | No repeated equivalent notifications | ENG-027 |
| ER-43 | Feedback is recorded | — |
| ER-44 | PostgreSQL is canonical | ENG-020 |
| ER-45 | Integrity primitives | ENG-021 |
| ER-46 | Required uniqueness | ENG-021 |
| ER-47 | Versioned migrations | ENG-020 |
| ER-48 | Source metrics | — |
| ER-49 | Funnel and AI/notification metrics | — |
| ER-50 | Drift warning | — |
| ER-51 | Backup and restore | ENG-020 |
| ER-52 | State survives transient failures | ENG-027 |
| ER-53 | Authenticated seeded user | — |
| ER-54 | Server-side ownership | — |
| ER-55 | Secret management | ENG-032 |
| ER-56 | Log hygiene | ENG-032 |
| ER-57 | Untrusted external content | ENG-010 |
| ER-58 | Telegram linking token | — |
| ER-59 | Automated verification required | ENG-029, ENG-033 |
| ER-60 | Unit coverage | ENG-029 |
| ER-61 | Integration coverage | ENG-030 |
| ER-62 | Real-data fixtures | ENG-014 |
| ER-63 | Determinism test | ENG-012 |
| ER-64 | Failure tests | ENG-031 |
| ER-65 | Regression discipline | ENG-014 |
| ER-66 | Definition of Done | ENG-020, ENG-033 |
| ER-67 | I/O-free domain | ENG-012, ENG-015 |
| ER-68 | Persistence behind ports | ENG-015 |
| ER-69 | Explicit ports | ENG-015, ENG-016 |
| ER-70 | Mechanically enforced boundaries | ENG-015 |
| ER-71 | No unjustified infrastructure | ENG-018 |
| ER-72 | Graceful degradation | ENG-008, ENG-026 |

### SRS rules with no dedicated `ER-nn` above

Two v1.1 rules are binding but are not yet elaborated by a dedicated rule in this document:

- **`ENG-022`** — database timestamps are produced/compared on the database clock in UTC and behaviour must not depend
  on a session timezone. (Partially reflected in the work-queue implementation; a rule will be added.)
- **`ENG-034`** — amending the SRS requires a version increment and a Document Control entry.

Project rules for these will be added rather than leaving the gap undocumented.
