# ADR-0010: Presence sweep under bounded listing coverage

- **Status:** Accepted — 2026-10-24 (owner selected windowed coverage; see §5).
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

`SweepSourceLifecycle` is invoked once, after a run finishes `SUCCEEDED` and made a coverage
claim (`catalogueExhausted` or a non-null floor). A failed sweep is logged and swallowed: a
good collection must not be failed by a downstream reconciliation step. The sweep is scoped to
the run's source, so it is bounded and retryable.

### 2.4 Policy version

`LIFECYCLE_POLICY_VERSION` is now `LIFECYCLE_V2`; the rule, the evidence shape, and the
migration from a boolean-only gate are one policy change.

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
- A source that intermittently truncates its listing will flap (one miss is enough to retire).
  The `ponytail:` note in the policy records the future fix: a consecutive-miss requirement and
  a policy-version bump, only once a real source shows that behaviour.

## 4. Alternatives rejected

| Alternative | Why not |
|---|---|
| Wire the sweep with "SUCCEEDED and discovered > 0" as the qualifier | Measured: retires 44 of 62 live EffoySira jobs on the first run. |
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
