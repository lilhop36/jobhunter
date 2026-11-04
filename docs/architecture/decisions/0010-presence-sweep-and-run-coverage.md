# ADR-0010: Presence sweep under bounded listing coverage

- **Status:** Accepted — 2026-10-24 (owner selected windowed coverage; see §5); amended 2026-11-01
  by the audit's M1 fix (see §8), and 2026-11-04 by the audit's L9 fix (see §9).
- **Date:** 2026-10-24
- **Relates to:** FR-019, SRS 4.4 (job lifecycle), AC-018, ENG-001 (no evidence is not negative evidence), ADR-0001 (identity), ADR-0004 (adapter registry)
- **Depends on:** ADR-0001 accepted; the `source_runs` funnel counters and the adapter registry exist.

## 1. Context

FR-019 requires expired, removed, and dead jobs to be detected. Of the three states, only
**removed** is derivable from persisted evidence: a Job is absent from a collection of its own
source. `EXPIRED` is owned by the deadline policy and `NOT_FOUND` is owned by a dead-link probe
that does not exist.

`SweepSourceLifecycle` implements the presence rule and has a real-PostgreSQL suite, but it has
no production caller. It cannot simply be wired: its evidence premise — "a successful run that
discovered at least one record saw the whole catalogue" — is false for all three approved
sources.

Measured 2026-10-23/24:

| Source | Listing size | Pages read per run | Latest qualifying run | ACTIVE jobs it discovered |
|---|---|---|---|---|
| EffoySira | 84 listing pages | 2 | 2026-10-22 14:48Z | 18 of 62 |
| Ethiojobs | `meta.lastPage` 94 | 2 (12 entries each) | 2026-10-24 | 24 of 24 |
| JobWebEthiopia | 126 listing pages | 1 listing page + 6 posts | 2026-10-22 | 6 of 6 |

Wiring the sweep as it stood would have retired **44 of 62 live EffoySira jobs** on the first
run. Full-catalogue reads are not a fix either: at the publishers' politeness budgets (30 s
between JobWebEthiopia requests, 800 ms for the others) the archives are hundreds of requests
away, and the schedule, not the page budget, is what keeps discovery fresh.

A run therefore needs a *coverage claim*: a declaration of which part of the listing it
actually observed. Absence is evidence only inside that part.

## 2. Decision

### 2.1 Two forms of coverage claim, recorded per run

Each `source_runs` row carries:

- `catalogueExhausted: boolean` — the run read the listing to a confirmed end. Only then is
  "not observed anywhere" evidence of removal.
- `oldestListingPublishedAt: timestamp | null` — the oldest publication date among the listing
  entries the run actually read. Listings are served newest-first, so those entries are the
  newest prefix; an unobserved Job published **strictly after** the floor was inside the part
  the run saw. `NULL` means the run makes no window claim.

A window claim requires every read entry to be identified and dated. One unreadable or undated
entry could be the oldest one read, which would make the floor a guess; the run then records no
floor and the sweep ignores it. An aborted run records neither signal.

The floor is stored as `timestamptz(3)` (ENG-022), while `jobs.publishedAt` remains the existing
naive `timestamp(3)` holding a UTC value. The read model therefore compares them as
`(publishedAt AT TIME ZONE 'UTC') > oldestListingPublishedAt`, so the window boundary cannot move
with the session's zone.

The floor is compared with a **strict** `>` because publication dates are date-only: a page
boundary can split a day, so an equally-dated entry may sit on the unread next page. The floor
date itself is therefore excluded from the window.

### 2.2 The decision rule (`LIFECYCLE_V2`, `@domain/lifecycle`)

For a Job whose status is `ACTIVE` or `REMOVED`:

1. If no informative run can speak for the Job, keep the status.
2. If the Job was observed at or after that run's start, it is `ACTIVE` — presence is direct
   evidence and needs no window.
3. If the run read the whole listing, it is `REMOVED`.
4. If the Job's publication date is strictly inside the run's window, it is `REMOVED`.
5. Otherwise keep the status: the run has no evidence about that Job, and "no evidence" is not
   "negative evidence" (ENG-001).

"Can speak for the Job" is resolved per Job by the read model: the newest `SUCCEEDED` run that
discovered at least one record and either captured the Job, exhausted the listing, or recorded
a floor below the Job's date. A newer capped run that does not reach an old Job does not erase
what an earlier complete read covered; it simply is not the run that decides. Runs that
discovered nothing, failed, or were aborted never qualify.

Only `ACTIVE` and `REMOVED` are reconciled. `EXPIRED` and `NOT_FOUND` come from other evidence
and are never overwritten from listing presence.

### 2.3 Trigger

`SweepSourceLifecycle` is invoked once, after a run finishes `SUCCEEDED` — with a coverage claim or
without one. The original trigger also required a claim; §8 records why that was dropped. A failed
sweep is logged and swallowed: a good collection must not be failed by a downstream reconciliation
step. The sweep is scoped to the run's source, so it is bounded and retryable, and every write it
makes is fenced on the status the pass read (§8).

### 2.4 Policy version

`LIFECYCLE_POLICY_VERSION` was `LIFECYCLE_V2`; the rule, the evidence shape, and the
migration from a boolean-only gate were one policy change. **Amended 2026-11-04:** §9 raises the
miss count and moves the version to `LIFECYCLE_V3`; the evidence shape and coverage rules above
are unchanged.

## 3. Consequences

- **Removal is reachable in production** for the newest part of each listing. The width of that
  part is the page budget: EffoySira's two listing pages and JobWebEthiopia's one page + six
  posts define today's windows. Raising a budget widens the window without any policy change.
- **Old removals are not detected** until a run reads far enough to cover them. That is the
  honest limit of a polite crawler, and it is now visible in the data (`oldestListingPublishedAt`)
  rather than assumed away.
- **No false retirement at rollout:** measured before wiring, EffoySira's window floor was
  2026-10-21 with 44 unobserved jobs, none published strictly after it; every stored Ethiojobs
  (24) and JobWebEthiopia (6) Job was inside the newest prefix its latest run read and was
  observed there. The expected first-sweep movement was zero for all three sources.
- **One nullable column plus one boolean** on `source_runs`, both additive. Pre-existing rows
  make no claim (the safe direction) and are simply not qualifying runs.
- A source that intermittently truncates its listing would have flapped under §2.2's single miss:
  one covered run's silence retired a Job and the next run restored it, discarding its match and
  notification history each time. §9 replaces that count with consecutive misses.

## 4. Alternatives rejected

| Alternative | Why not |
|---|---|
| Wire the sweep with "SUCCEEDED and discovered > 0" as the qualifier | Measured: retires 44 of 62 live EffoySira jobs on the first run. The trigger is that condition again today (§8) and it is safe only because §2.2's rule moved inside the read model: a claim-less run can restore what it captured, but it can never speak for what it did not read. |
| Require `catalogueExhausted` only | Correct but inert: no approved source can read its archive within its politeness budget, so `REMOVED` would stay unreachable. |
| Count missed runs or days instead of a window | Needs the same coverage evidence to be safe, adds a tunable threshold, and still cannot distinguish "older than the pages read" from "removed". |
| Retire every unobserved Job | Mass false retirement; violates ENG-001. Treating "not read" as "not published" is exactly the error this ADR exists to prevent. |
| Enlarge page budgets until a full read fits | Hundreds of requests per run at the publishers' crawl delays; defeats the schedule and the source's stated politeness. |
| Keep the sweep unwired | FR-019 stays implemented but inert; `REMOVED` is never set in production. |

## 5. Owner sign-off

On 2026-10-24 the owner selected **windowed coverage**: record the oldest publication date a run
actually read, and retire only Jobs published strictly inside that window and not observed. The
measured effect at the time was zero false retirements, with removal detection limited to the
newest N postings and widening as the page budget widens.

## 6. Out of scope

- **`NOT_FOUND` (dead application target).** Detecting it requires fetching each target, which
  spends the same politeness budget as collection and has its own evidence question (a timeout
  is not proof of death). No probe is added here; D9/D10 stay open for a separate ADR.
- **`MATERIAL_CHANGE`** and any derived-from-description lifecycle state remain out of scope.
- **Raising page budgets.** This ADR makes the existing budgets safe; measuring saturation and
  choosing new budgets is a separate, evidence-first change.

## 7. Verification

- `tests/unit/lifecycle-policy.spec.ts` — the rule: exhausted read, in-window retirement, floor
  exclusion, older-than-window, undated Job, missing floor, restore.
- `tests/integration/lifecycle-sweep.spec.ts` — real PostgreSQL: the decision boundary plus the
  run-selection rules (failed, capped with no claim, newer capped run vs older complete read,
  source scoping, idempotence).
- Adapter suites — each source reports its floor only when every read entry was identified and
  dated; an unreadable or undated entry yields `NULL`.
- `tests/integration/source-run-identity-counters.spec.ts` — the floor round-trips through
  `source_runs` without a timezone shift.

## 8. Amendment — 2026-11-01: trigger widened, writes fenced (audit M1)

Neither change alters the rule in §2.2; both were found by the 2026-10-25 full-system audit.

1. **Presence restores without a coverage claim.** §2.2's read model already counts "this run
   captured the Job" as a run that can speak for it, and rule 2 restores on presence alone.
   Requiring a claim in the *trigger* therefore only ever delayed restoration: a Job re-published by
   a capped run that recorded no floor stayed `REMOVED` until some later run happened to state
   coverage. The handler now sweeps after every `SUCCEEDED` run. Retirement is unaffected — rules 3
   and 4 still need a run that read the listing to the end or reached below the Job's date, so a
   wider trigger creates no new evidence of absence.
2. **Each write is a compare-and-set.** `LifecycleStatusUpdate` carries the status the deciding pass
   read, and the store applies the move only while the row still holds it. The presence and deadline
   policies write the same column and interleave under a second worker or a re-claimed task; before
   this, whichever write landed last won, and could replace a determination it cannot re-derive —
   an `EXPIRED` from a stated deadline, or a `REMOVED` from a covered read — with a conclusion drawn
   from a read that no longer describes the row. A move whose expectation no longer holds is dropped,
   not retried: the other writer acted on fresher evidence, and the next pass re-reads before deciding
   again. The gap is logged with `decided`/`applied`/`superseded`, because the log is the only place a
   lifecycle reason is recorded.

Tests for the amendment: `lifecycle-sweep.spec.ts` (a claim-less run restoring a `REMOVED` Job; the
fence refusing to overwrite a status moved underneath the pass; the deadline policy winning a race
mediated between the pass's read and its write) and `deadline-expiry.spec.ts` (the mirror case, where
presence retires during the deadline pass).

## 9. Amendment — 2026-11-04: consecutive misses before retirement (audit L9)

Supersedes the miss count in §2.2 (rules 1–2), the version in §2.4, and the flapping consequence in
§3. Nothing else in §2 changes: which run may speak for a Job, and what its coverage claim means, are
untouched.

1. **Why.** One covered run's silence retired a Job, and the next run restored it. A source that
   intermittently truncates a page therefore produced a retirement/restoration cycle on every flap,
   and each flap discarded that Job's match and notification history — the record the product
   depends on. The rule also claimed more than the evidence supports: a single observation of
   absence cannot separate "removed" from "on a page this run's budget cut off", and the coverage
   window narrows that doubt without removing it.
2. **Rule.** A Job is retired only when the two most recent runs that could speak for it (§2.2's
   qualifier) both missed it, and the older of the two covered its publication window.
   `LIFECYCLE_MISS_THRESHOLD` is 2. The read model selects the newest qualifying run and the one
   before it from one shared predicate, so runs that never qualified — failed, partial, empty, or
   capped above the Job's date — are skipped and never accumulate toward removal. A Job observed by
   either of the two is `ACTIVE`.
3. **Presence still restores immediately.** The newest qualifying run is read for exactly this
   reason: a Job removed under the old rule and re-published by the source's only recent collection
   is restored on that observation, without waiting for a second run.
4. **Version.** `LIFECYCLE_V3`. The version accompanies every lifecycle move in the log, so a log
   carrying `V2` was produced by the single-miss rule and its retirements are not comparable.

Consequence: retirement now trails the source by one collection cycle. That is the intended cost of
not flapping; the window in §2.1 still limits removal to Jobs the runs actually covered.

Tests: `tests/unit/lifecycle-policy.spec.ts` (one miss keeps the Job, two consecutive misses retire
it, a capture at either run's start counts as observed, no second run means no retirement) and
`tests/integration/lifecycle-sweep.spec.ts` (one miss kept, two consecutive misses retired, a
re-observation resetting the count, failed/partial/empty/claim-less runs not counting as misses, and
the windowed-coverage cases rebuilt on the two-run history).

