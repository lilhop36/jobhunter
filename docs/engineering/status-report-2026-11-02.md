# JobHunter — project status and remediation report

**Date:** 2026-11-02
**For:** the owner/operator (not an engineering onboarding document)
**Covers:** the full-system audit of 2026-10-25 and everything remediated since, through commit `f39ba83`
**Detail lives in:** [full-system-audit-2026-10-25.md](./full-system-audit-2026-10-25.md) (findings and evidence),
[srs-implementation-drift-2026-10-23.md](./srs-implementation-drift-2026-10-23.md) (requirement gaps),
the ADRs in [architecture/decisions](../architecture/decisions).

---

## 1. The short version

The audit said the system was "not safe to operate as-is" for four reasons: the database was behind
the code, there was no authorization boundary, a crash could disable a source for hours, and two
data-integrity rules were being violated in the direction the engineering instructions forbid.

**All four are closed.** Along with them, every high and medium finding is closed except four: M6 (job
identity and provenance retention), M8 (release gate, supervision, dependency hygiene), M9
(accessibility labels) and the part of M7 that only you can do — installing the backup schedule and
keeping an encrypted copy off the machine. The ten low findings are untouched except L11, a test-suite
bug that was fixed the day it appeared, and L12, a hazard in how I run the suite, recorded today.

The pipeline is running against the real sources right now and producing sane numbers: the three
collections started at 17:21 today all succeeded, and none of them hit an HTTP error.

What is left is real but bounded: one identity fix that has to be migrated carefully (it can
otherwise destroy job history — section 6), accessibility labels, and the operational half of the
security and backup work (TLS, a scheduled backup task, an off-machine encrypted copy) which only you
can do, because they are choices about your machine and your network, not code.

---

## 2. Where the project stands

| | |
| --- | --- |
| Commits | 143 total; 30 of them since the audit |
| Working tree | clean |
| Database | live `jobhunter` at 16/16 migrations, "up to date" |
| Test suite | 84 spec files / 1099 tests — `npm run verify` green (type check + full suite) at 22:51 on 2026-11-02 |
| Jobs stored | 163 — EffoySira 79, Ethiojobs 72, JobWebEthiopia 12 |
| Raw captures | 168 rows in `raw_jobs` (append-only evidence, never overwritten) |
| Matches | 300 scored job/candidate pairs |
| Notifications | 1 outbox row — the eligibility gates are still rarely met, see section 5 |
| Sources | 3 approved adapters, all collecting on schedule |
| Identity | 1 user, login by one-time local code (no password, no `?userId=` link) |

---

## 3. Findings register

Dates are when the fix landed. "Verified" means a regression test exists and passed, not that I read
the code and nodded.

### Closed

| Ref | What it was | Resolved |
| --- | --- | --- |
| H1 | Schema drifted from code; `/dashboard` and `/api/sources` returned 500 while `/health` said ok | 2026-10-27 (migrations applied, both pages 200) |
| H2 | No authorization boundary anywhere; loopback binding was the only control, `Host` unchecked | 2026-10-30 (ADR-0011) |
| H3 | A crash during collection burned the recovery task's retries and idled the source 3–6 h | 2026-10-27 queue, 2026-10-31 heartbeat |
| H4 | A partial recapture overwrote known canonical facts with UNKNOWN | 2026-10-27 (`applicationDeadline` left as an owner decision) |
| H5 | The deadline parser invented a deadline from an unrelated date on the same line | 2026-10-27 (clause-anchored, `DEADLINE_EXTRACTION_V2`) |
| H6 | One malformed EffoySira timestamp failed and orphaned the whole run | 2026-10-27 |
| H7 | SRS §7.8 reduced-yield detection absent | 2026-10-28 yield drift, 2026-10-30 source silence |
| M1 | Lifecycle and deadline reconciliation were last-writer-wins | 2026-11-01 (compare-and-set + restore-on-observation) |
| M2 | A running source run looked dead; a dead one kept writing | 2026-10-31 (heartbeat, reap by inactivity) |
| M3 | Outbox rows could be stranded; dispatch didn't re-check eligibility | 2026-11-01 (2 halves declined, see below) |
| M4 | A source with no resolvable adapter was re-enqueued every 30 s forever | 2026-11-01 |
| M5 | Adapters could be pointed at internal hosts by a job page, and a source's own 403/429/500s were invisible | 2026-11-02 (both halves) |
| M10 | New timestamp columns broke the timezone-aware rule | 2026-10-27 |
| L11 | Two suite files failed on a `beforeAll` hook timeout while every test inside passed | 2026-11-01 (`hookTimeout: 120_000`) |

### Open

| Ref | What it is | Status |
| --- | --- | --- |
| M6 | Provenance retention and identity-key stability | in progress, planned in 3 commits; see section 6 |
| M7 | Backups were scripts, not a capability | code done 2026-10-30; the schedule task and the encrypted off-machine copy are yours |
| M8 | No CI, no lint gate, no supervision; Fastify 4 with 2 high audit findings | not started; needs your decision on CI |
| M9 | Some form controls have no accessible name; the a11y test overstates coverage | not started |
| L1–L10, L12 | Cursor validation → 500 instead of 400; unbounded session `Map`; the API process is handed the Telegram token; a CSRF claim in an ADR that nothing implements; stale docs; no DB `CHECK` constraints; relative-URL canonicalisation; funnel metrics stop before matched/notified; coverage retirement flaps; `NOT_FOUND` never produced. L12 is new today: two test suites sharing one database truncate each other's fixtures | not started (scheduled after M6); L12 is documented with the operating rule, and the lock that would enforce it is deliberately not built yet |
| H8 / D-series | Requirement gaps that are product decisions: `JobSkill` (D4), cross-source dedupe (D8), AC-017 buttons (D13), AC-020 precision (D21), funnel/notification metrics (D20), `NOT_FOUND` (D9) | deliberately not "fixed" — each needs your call |

### Two things we chose not to fix

M3 had four parts; two were declined on purpose and the reason is recorded on the finding. The
multi-instance lease is schema and machinery for a deployment that doesn't exist (single worker), and
re-notifying a cancelled event is a product decision about what an event identity *means*, not a
missing `WHERE` clause. Both are documented as deliberate, with the marker for when to revisit.

---

## 4. What actually changed in behaviour

**Authorization.** Nothing in the API trusts a caller-supplied `userId` any more. Web pages sign in
with a one-time code you mint locally; API calls need a signed credential. Bind to a non-loopback
address without a secret configured fails closed instead of quietly exposing the app.

**Failure detection.** A source that stops producing, or produces far less than it used to, now shows
up as DEGRADED health with a reason, instead of a green `SUCCEEDED` run and silence. A source that
answers with HTTP errors is now counted: `httpFailures` on the run, a note in the error summary, and
the run is PARTIAL rather than a success with holes in it.

**Untrusted input.** Job pages are now treated as hostile, which they are. All three adapters share
one HTTP policy: https only, the source's own hostname only, redirects followed manually and
re-validated hop by hop, five-hop cap, 2 MiB body cap enforced while streaming rather than after. A
link on a listing page that points off-host is refused and voids the run's coverage claim instead of
being silently dropped.

**Crash recovery.** A crashed collection no longer burns its retries and dead-letters itself. Runs
carry a heartbeat, so a live run isn't reaped and a dead one can't keep writing.

---

## 5. Live behaviour under the fixes

Runs started 2026-11-02, read from the live database:

| Source | Started | Status | Discovered | Duplicates | HTTP failures | Coverage floor |
| --- | --- | --- | --- | --- | --- | --- |
| EffoySira | 17:21 | SUCCEEDED | 18 | 1 | 0 | 2026-10-30 |
| Ethiojobs | 17:21 | SUCCEEDED | 24 | 0 | 0 | 2026-11-02 |
| JobWebEthiopia | 17:22 | SUCCEEDED | 6 | 6 | 0 | 2026-10-29 |

All three sources no longer make a `catalogueExhausted` claim at their page budget — they make a
window claim floored at the oldest posting date they actually read. That is the "Windowed coverage"
decision, and it is what stops the lifecycle sweep from retiring a job the run simply never reached.

Two observations worth your attention:

- **JobWebEthiopia yields 6 postings and today's were all already known.** Its 2-page budget is the
  reason. If you want that source to cover more ground, the budget is the knob, not the code.
- **Only one notification exists against 300 matches.** The gates are minScore 60 *and* minConfidence
  45, and the sample scores seen so far were 72/confidence 33 and 50/confidence 47 — one high, one
  wide, neither through both doors. That is the system behaving as specified, not a bug, but if the
  intent was "alert me sometimes", the thresholds need your review.

---

## 6. The one remaining item that could cost you data

M6 is not a cosmetic fix. Ethiojobs records its job identity as the posting *slug*, and that slug
contains the posting title (`zl7WeQ1Xpn-packaging-operator-harar`). The identifier contract says an
adapter only populates a stable identifier when it has verified it is stable; a title is not stable —
the publisher can retitle a posting, and the record then looks like a brand-new job.

The dangerous part is the ordering. A source-provided identifier outranks the canonical URL when
identity is resolved, so the slug **is** the live identity of all 72 Ethiojobs jobs. Changing the
adapter to use the stable id segment without also rewriting the stored keys would give every existing
posting a new identity: 72 duplicate jobs, and the sweep retiring the originals — with their match and
notification history. That is why this is a planned migration and not a two-line edit.

The plan, in three reviewable commits:

1. `rawContentHash` gains a canonicalised `rawPayload` segment, with a version bump scoped to the raw
   kind only, so content and identity fingerprints stay `v1`. Consequence: one extra raw row per
   existing posting on its next sighting. That is append-only history, which is allowed; rewriting a
   stored payload is not.
2. The Ethiojobs identifier switches to the slug's leading id segment, together with a forward-only
   migration over the stored identifier and identity keys. Checked read-only against the live
   database first: 72 distinct identifiers → 72 distinct leading segments, none shared, none empty, so
   the rename is deterministic and collision-free today.
3. A guard on the coverage window: the rule assumes listings are newest-first. If a later-read
   posting turns out newer than an earlier-read one, the run's window claim is voided and the reason
   is recorded, instead of the system quietly retiring jobs it never saw.

Step 2's migration gets applied to `jobhunter` only after a backup and a restore check.

---

## 7. What is verified, and what is not

**Verified by tests that exist and pass.** Every closed finding above has a regression test named for
it — the audit records which. The full gate ran clean for M5: `npm run verify` (disk preflight,
`tsc --noEmit`, then the whole suite) exited 0 with **84 files / 1099 tests passed**, 14 minutes.

**Verified against the live system.** Migrations up to date on `jobhunter`; `/dashboard` and
`/api/sources` returning 200; the three sources collecting with the new HTTP policy (section 5); the
sign-in flow proven in a real browser rather than only in-process; run counters read back from the
database.

**Not verified — and you should know which box each of these is in.** TLS on an externally bound API
is not implemented at all. The backup schedule task is not installed, and there is no encrypted
off-machine copy — the scripts exist and the restore drill passes locally, but that proves the *code*,
not your *recovery*. No CI, no lint gate. No load or soak testing, no multi-worker stress, no
Telegram end-to-end delivery test.

**Environment caveats that will bite you.** The verify command refuses to run under 500 MB of free
disk, and this machine was at 22 MB during this cycle; it needed 4 GB freed to get through the suite.
The worker shares the machine while the suite runs, which is what made the `prisma migrate deploy`
hook time out in the first place (L11). **Run one suite at a time:** every integration file truncates
the single shared `jobhunter_test`, so a second concurrent suite deletes the first one's fixtures
mid-test and the result looks like four real product failures — a foreign-key violation on
`source_runs`, a 404 for a source that exists, "No Job found". That happened to me on this cycle, and
the same tests passed standalone minutes later; the hazard is now recorded as L12. And on this host,
Node's `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY` unless the worker starts with `NODE_USE_ENV_PROXY=1`
— without it every collection fails with `TypeError: fetch failed`, which is exactly what the 8 failed
runs in the history are.

---

## 8. What's next in this cycle

Roughly in order: finish M6 (three commits, migration applied only after a backup check), then M9
accessibility labels and error association, then the low items starting with cursor validation and the
`TELEGRAM_BOT_TOKEN` leak into the API process, then a final full verification with the docs
reconciled.

Your side, whenever you get a chance: install the backup schedule task, choose an off-machine
directory for the encrypted copy, and decide whether M8 gets a CI/lint gate.

---

*Skipped / not checked: the L12 collision was diagnosed from the run log and a clean standalone
re-run, not from a reproduction of the two suites racing on purpose; the JobWebEthiopia low yield and
the notification-threshold observation are read from live run rows, not from a design document; and
L1–L10 statuses are copied from the audit register rather than re-verified against current code.*
