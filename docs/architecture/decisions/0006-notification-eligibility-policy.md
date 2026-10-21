# ADR-0006: Notification eligibility policy

- **Status:** Proposed — the threshold constants need owner review (see §7). The policy, the
  schema and the migration are implemented and tested; nothing writes or delivers a notification
  yet.
- **Date:** 2026-10-19
- **Relates to:** SRS v1.1 §3.2, §3.5, §4.8, §5.2, §5.6, §11.3; FR-016, FR-017, FR-018; AC-004,
  AC-015, AC-016, AC-017; ENG-007, ENG-008, ENG-014, ENG-027, ENG-030
- **Depends on:** the stored match (ADR-0005, built) and the outbox tables (built,
  `prisma/migrations/20261019130000_notification_outbox`)
- **Blocks:** Milestone 3 (SRS 11.3) — "useful alerts arrive reliably"

## Why this needs its own record

SRS 3.2 states eligibility as one conjunction — ACTIVE, a usable application target, not already
notified for the equivalent event, score above a threshold, confidence above a threshold, not
suppressed or rejected — but it fixes **no numbers**, exactly as §4.6 leaves the matcher weights
unset. Those two numbers decide which jobs interrupt the user, and ENG-014 treats a change to
notification eligibility as a change that must be versioned and traceable rather than tuned
silently in code. They are recorded here and pinned by tests.

The second reason is a genuine tension the SRS cannot resolve on its own. Job-side skill
extraction does not exist (ADR-0005 §2), so the Skills factor — 30 of the 100 weight points — is
**permanently UNKNOWN**, which caps achievable confidence. A threshold set as if the matcher were
complete would silence the system; a threshold set low enough to ignore that would deliver
guesses. §3 does the arithmetic and states the consequence.

## Decision

### 1. Eligibility is a pure domain function

`evaluateNotificationEligibility(input, options)` (`src/domain/notification/notification-eligibility.ts`)
is total and pure: no I/O, no clock, no randomness, no AI, no persistence. `alreadyNotified` and
`rejectedByUser` arrive as inputs rather than being queried, so the policy is testable and
explainable without a database.

It returns every failing predicate, not just the first (`reasons`, in SRS 3.2 order) plus a
deterministic `explanation` naming the numbers. "Score 54 is below the 60 threshold" and "no
usable application path" are different answers to "why was I not told about this job", and a
first-failure short-circuit would hide the second one.

### 2. The SRS predicates, mapped

| SRS 3.2 predicate | How it is decided |
|---|---|
| ACTIVE | `lifecycleStatus === ACTIVE` (SRS 4.4 lifecycle states) |
| usable application target | `hasUsableApplicationPath(target, policy)` — the existing SRS 3.5 / AC-004 rule, not a second copy of it |
| not already notified for equivalent event | the caller's `alreadyNotified`, resolved from the outbox event key (§4) |
| score >= threshold | `score` vs `minScore`, **inclusive** |
| confidence >= threshold | `confidence` vs `minConfidence`, **inclusive**, and independent of score (ENG-028) |
| not suppressed/rejected | the caller's `rejectedByUser` (feedback `NOT_RELEVANT`, FR-018) |

Informational listings stay off by default: `policy.allowInformationalListings` is the explicit
opt-in SRS 3.5 requires.

### 3. Thresholds

```ts
NOTIFICATION_THRESHOLDS_V1 = { minScore: 60, minConfidence: 45 }   // Percent, inclusive
```

- **Score 60.** Scores renormalize over the factors that had evidence, so a score is only
  comparable between jobs when their evidence is comparable — that is why confidence is a
  separate gate rather than being folded into this one.
- **Confidence 45** (owner-approved 2026-10-21 for the validation period). Confidence is
  `knownWeight / totalWeight × weighted extraction certainty` over all seven factor weights
  (100). With Skills (30) and Experience (15) permanently UNKNOWN and Employment (5) unreached
  in practice, `knownWeight` for title-only postings ceilings at 50/100, so completeness caps
  at 0.5 and an exact role match still tops out around 47% confidence — demonstrated live on
  48 collected EffoySira postings (best: 95/100 relevance, 47% confidence, zero reservations
  at `minConfidence = 50`). Threshold 50 therefore silenced the system entirely; 45 admits
  role-confirmed postings that also carry location and salary evidence, and stays far above
  the zero-evidence guesses.
- The consequence, stated plainly: **with Skills permanently UNKNOWN, an eligibility decision is
  always made on at most 70% of the intended evidence — and in practice on ~50%.** When job-side
  extraction lands, these numbers must be re-derived rather than kept, and the change is a new
  `NOTIFICATION_ELIGIBILITY_VERSION`.

### 4. Event identity (ENG-027, AC-016)

The event key is `(userId, jobId, notificationType, event)`, enforced by a **plain** unique index
`one_notification_per_event`. Plain, not partial: a partial index would let the same event back in
once the first row reached `SENT`. The check is the database's, so two workers racing the same
event cannot both insert.

v1 has exactly one type and one event, `NEW_MATCH`: **one notification per (user, job), ever**.
SRS 3.2 allows a repeat "unless an explicitly supported material-change event occurs", and v1
supports none — no material-change event is defined here, so nothing may re-notify. The ceiling is
deliberate: a job that discloses its salary after the first notification will not produce a second
one until a material-change event exists as a documented, versioned addition.

### 5. The write path ENG-027 requires (not built yet)

ENG-027: "The match and its notification outbox row are written in one transaction." That is not
how the code is arranged today — `PrismaJobMatchRepository.saveIfChanged` opens its own
transaction — so the outbox row cannot simply be inserted afterwards. The writer is the next
increment: eligibility must be evaluated inside the scoring transaction and the reserved row
inserted with the match, or the two must move into one use case that owns both inserts.

This ADR deliberately does **not** ship a repository method with its own transaction, because that
seam would encode the wrong boundary and the next increment would have to undo it. Today the
tables have no writer; that is reported, not implied.

### 6. Persistence

Two tables, `notification_outbox` and `notification_feedback`. Both are hand-written migrations
verified against `schema.prisma` with `prisma migrate diff` ("No difference detected"), and the two
unique indexes are guarded by `tests/integration/partial-indexes.spec.ts` so a regenerated
migration cannot drop them silently.

Engineering additions to the SRS 5.2 attribute list, reported as such:

- `event` — the event name. SRS 5.2 gives `notificationType` but ENG-027 needs a key per *event*
  within a type; v1's single value is `NEW_MATCH`.
- `jobMatchId` — which match was announced. Nullable, because SRS 3.5 lets a policy notify
  informational listings that have no match. `ON DELETE SET NULL`: deleting a match must not erase
  the record that the user was told.
- `attemptCount` is SRS 5.2; there is no `nextAttemptAt`-equivalent state machine beyond the
  `NotificationStatus` enum that already existed in the schema.

`notificationType` and `event` are plain strings rather than enums: Appendix A defines no value
set for the former, and v1 has exactly one of the latter. They become enums when a second value
exists.

### 7. Review items (owner sign-off needed)

1. `minScore = 60` — is a relevance of 60/100 the bar for interrupting the user?
2. `minConfidence = 45` (owner-approved 2026-10-21). With the ~50 practical ceiling for
   title-only postings, 50 silenced the system entirely — sign-off moved it to 45 as the
   validation-period value. When extraction lands, re-derive rather than keep.
3. One `NEW_MATCH` notification per (user, job), forever, with no material-change events in v1
   (§4). Confirm that refusing to re-notify is the intended behaviour.
4. Both thresholds are inclusive; a job exactly at the bar is eligible.
5. Feedback replaces the previous verdict (one row per notification) rather than accumulating
   contradicting rows.

### 8. Explicitly not built

Telegram linking and the short-lived deep-link token (SRS 3.2), delivery and the dispatcher, retry
and 429 backoff (FR-017), the outbox due-scan, `GET /api/notifications`,
`POST /api/notifications/:id/feedback`, and notification precision measurement (SRS 10). No
Telegram credential is read, stored or logged by anything in this change.

### 9. Reported, not patched

- The SRS's "usable application target" is reused from `hasUsableApplicationPath`, including its
  current limits: `SOURCE_ACCOUNT` and `INSTRUCTIONS` are valid SRS states that no current
  producer emits.
- Nothing enforces that a notification's `payload` satisfies SRS 3.2's content list, because
  nothing renders it yet.
