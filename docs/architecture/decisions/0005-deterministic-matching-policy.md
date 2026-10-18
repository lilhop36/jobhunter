# ADR-0005: Deterministic matching policy

- **Status:** Proposed — the scoring constants need owner review (see §7). The matcher itself is implemented and unit-tested.
- **Date:** 2026-10-18
- **Relates to:** SRS v1.1 §4.5, §4.6, §5.2 (`CandidateProfile`, `JobMatch`), §6.7, §10.4, Appendix A, Appendix B.3; FR-012–FR-015; AC-009, AC-010; ENG-001, ENG-004, ENG-005, ENG-007, ENG-012, ENG-013, ENG-028
- **Depends on:** the persisted candidate profile (built, `tests/integration/candidate-profile-repository.spec.ts`) and job-side skill extraction + a canonical skill dictionary (not yet built), which supply §2's inputs
- **Blocks:** Milestone 2 (SRS 11.2) — "real jobs receive explainable deterministic matches"

## Why this needs its own record

The SRS fixes the **shape** of matching (seven factors, their initial weights, the skill-credit
ladder, the UNKNOWN rule) but leaves the **numbers** inside those rules unset: how much
partial credit a `RELATED_SKILL` earns, how fast freshness decays, what "evidence
completeness × extraction certainty" means arithmetically. Every one of those numbers moves a
score, and a score decides whether a job is worth the user's attention. They are recorded
here, versioned, and pinned by tests rather than left implicit in code.

## Decision

### 1. The matcher is a pure domain function

`scoreMatch({ profile, job, now })` (`src/domain/matching/score-match.ts`) is a total, pure
function: no I/O, no clock, no randomness, no AI, no persistence. `now` is an injected input
(ENG-012), so identical input and `matcherVersion` yield identical output (AC-009), and the
same job can be re-scored offline against a stored profile version.

Score and confidence are **different quantities** (ENG-028, SRS 4.6 "Confidence"):
`score` is relevance in `Percent` [0,100]; `confidence` is evidence completeness ×
extraction certainty, also `Percent`, and is never derived from `score`. Both are validated
`Percent`s at construction.

### 2. Inputs

The matcher consumes only facts a previous stage already derived. It parses no text and
invents no field (ENG-001, ENG-016):

| Input | Origin |
|-------|--------|
| `CandidateProfile` (skills, target roles, location preferences, remote/relocation/salary/employment preferences, `experienceYears`, `profileVersion`) | the single seeded profile (FR-012, SRS 5.2) |
| `MatchableJob` (title, `descriptionQuality`, location category/text, `remoteStatus`, `employmentType`, `SalaryParsed`, `DateParsed`, evidenced skills, required experience) | the normalized `Job` |
| `now` | injected |

`MatchableJob.requiredExperience` and `MatchableJob.skills` have **no producer yet**: required
experience and job-side skills are deterministic extraction work that is not implemented, so
until it is, those two factors are UNKNOWN and are renormalized away. The matcher is therefore
useful *now* (role, location, employment, freshness, salary) and improves when extraction
lands, with no change to this interface.

### 3. Score, per factor

Each factor returns `KNOWN` (a score in [0,100] plus a certainty in [0,1]), `UNKNOWN`, or
`CONFLICTING`. Weights are SRS 4.6's initial hypothesis (role 25, skills 30, experience 15,
location 15, employment 5, freshness 5, salary 5).

| Factor | KNOWN when | Score | Certainty |
|--------|-----------|-------|-----------|
| role | title present and target roles configured | 100 for a target-role phrase in the title; otherwise 50–99 for token overlap ≥ 50% of the role's tokens; 0 otherwise | 0.95 exact / 0.6 partial |
| skills | profile has skills and the posting evidences skills | 100 × Σ(candidate skill confidence × credit) / Σ(candidate skill confidence), credit per §4 | 0.9 / 0.6 / 0.3 by `descriptionQuality` |
| experience | posting states required years and profile states years | 100 if met, else 100 × profile/required | the required years' extraction confidence |
| location | not both "no place" and "no remote status" | see §5 | 0.9 category / 0.6 free text |
| employment | employment type and preferences both known | 100 if accepted, else 0 | 0.9 |
| freshness | a publication date exists | 100 up to 7 days, linear to 0 at 60 days | the date's extraction confidence |
| salary | see §6 | 100 if the minimum is met, else 100 × offered/minimum | the salary's extraction confidence |

`0` is used **only** where the evidence contradicts the candidate (a title that matches no
target role, an unaccepted employment type, a location outside the preferences, a salary below
the floor, a posting that fails an exclusive remote/on-site preference). Absent evidence is
`UNKNOWN`, never `0` (AC-010, ENG-001).

### 4. Skill credit (SRS 4.6, Appendix A)

| Evidence | Credit |
|----------|--------|
| `EXACT_MATCH` | 1 |
| `CANONICAL_ALIAS` | 1 |
| `RELATED_SKILL` | 0.5 (cap) |
| `TRANSFERABLE` | 0.25 (cap) |
| `AI_SUGGESTED` | 0.5 (cap), and **0 below confidence 0.6** |
| `UNKNOWN` | 0 |

The confidence gate on `AI_SUGGESTED` implements "confidence-gated and capped": advisory
evidence must not move a score on its own (ENG-007). Candidate-side `confidence` weights how
much a skill's credit counts, so a tentatively held skill cannot dominate the factor.

Only skills the **candidate** lists are scored. A job-side observation the candidate never
claims is not a match; it is not recorded as missing either (missing means "a claimed skill the
posting does not evidence").

### 5. Location and remote (SRS 4.6 "Remote")

Exclusion first, and only from an **exclusive** preference:

| Candidate preference | Posting | Location factor |
|----------------------|---------|-----------------|
| `REMOTE_REQUIRED` | on-site | 0 |
| `ONSITE_ONLY` | remote | 0 |
| `REMOTE_PREFERRED` / `NO_PREFERENCE` | on-site | normal place matching below |
| any | remote | 100 |
| any | hybrid | 100 (`NO_PREFERENCE`), 90 (`REMOTE_*`), 50 (`ONSITE_ONLY`) |

For on-site postings the factor is 100 when the posting's category is among the preferred
categories, or when the posting's place text contains a preferred place's text; otherwise 50
if `relocationPreference` is `WILLING`, else 0. `UNDECIDED` is *not* willingness.

### 6. Salary (SRS 4.6 "Salary", ENG-006)

`NEGOTIABLE`, `AS_PER_SCALE`, `NOT_DISCLOSED` and `UNKNOWN` are **excluded** (UNKNOWN) unless
the profile sets `requireDisclosed`, in which case the factor scores 0 — the one place the SRS
permits undisclosed salary to count against a job. A disclosed salary is excluded when there is
no numeric minimum to compare against, or when currency or period contradicts the preference.
Comparison uses exact scaled-cent integer arithmetic, never binary floating point (ENG-006).

### 7. UNKNOWN rule, renormalization and confidence (SRS 4.6)

```
score      = round( Σ(scoreᵢ × weightᵢ) for KNOWN factors / Σ(weightᵢ) for KNOWN factors )
completeness = Σ(weightᵢ) for KNOWN factors / Σ(all weights)
certainty    = Σ(certaintyᵢ × weightᵢ) for KNOWN factors / Σ(weightᵢ) for KNOWN factors
confidence = round(100 × completeness × certainty)
```

A `CONFLICTING` factor is excluded exactly like an UNKNOWN one and is surfaced in
`uncertainEvidence`; it is never resolved by preferring one source (ENG-005). With no KNOWN
factor at all the score is 0 **and** confidence is 0, so "no evidence" is distinguishable from
"evidence that scored badly" — the latter has high confidence and a low score.

### 8. Explainability (FR-015)

Every factor contributes lines to `matchedEvidence` / `missingEvidence` / `uncertainEvidence`,
and `explanation` is assembled deterministically from those lines plus the scores — no AI, no
free prose (ENG-008). `matchedSkills` / `missingSkills` / `uncertainSkills` are the skill-named
subset for the Telegram "Why it matches" content (SRS 3.2).

### 9. Versioning

`MATCHER_VERSION = '1.0.0'` accompanies every result and is stored on `JobMatch`. Any change to
a weight, a cap, a threshold or a formula requires a new version (ENG-013); no test may be
updated to a new expected number without that bump.

### 10. Domain and candidate neutrality

The matcher is deliberately field-agnostic: it knows skills as canonical names, roles as
titles with aliases, locations as categories, and money as exact decimals. **No job field is
privileged** — software, health, construction, finance and everything else follow the same
rules, and adding a field means adding *data* (profile skills, target roles, and later a
skill lexicon entry), never branching in the matcher. Anything that would need a per-field
code path is a sign the scoring input is not canonical enough yet.

The profile is likewise not "the" profile: `CandidateProfileRepository.listProfiles()` returns
a list and every `JobMatch` is keyed by `userId` (SRS 5.6). v1 seeds a single candidate
(FR-012, Milestone 2), but nothing in the reader, the matcher or the persistence shape may
assume the list has one element. Running several candidates — and therefore serving several
fields at once — must be a data change, not a redesign.

The one deliberately field-independent dependency still missing is **job-side skill and
required-experience extraction** (§2), which must not ship with a hand-picked software
lexicon: it has to work from each candidate's own declared vocabulary plus an
operator-extendable canonical-alias table.

## What this policy explicitly does not do

- No AI in the scoring path (ENG-007, ENG-008); `AI_SUGGESTED` is one *input* class, capped.
- No learning, tuning or feedback-driven weight adjustment (SRS 10.4: baseline first).
- No cross-source identity, no profile inference, no reading of the job description text.
- No persistence, no thresholds, and no notification eligibility — those are the next
  increments (SRS 3.2 eligibility is `score ≥ threshold AND confidence ≥ threshold`, and the
  thresholds are deliberately unset until a baseline exists, SRS 10.4).
- No `CONFLICTING` producer: the state is handled, but nothing emits it yet.

## Open questions for the owner (§7 constants)

1. Skill caps `RELATED_SKILL 0.5` / `TRANSFERABLE 0.25` and the `AI_SUGGESTED` gate at 0.6 —
   accept as the v1 hypothesis drawn from the SRS ladder?
2. Freshness decay 7 → 60 days — accept, or a different window?
3. Role partial credit requiring ≥ 50% token overlap — accept, or exact/alias only?
4. Excluding a disclosed salary when there is no numeric minimum (rather than scoring it 100) —
   accept?
5. `CandidateSkill.skillType` reuses the Appendix A `SkillEvidence` ladder (the SRS names the
   attribute but no enum for it) — accept?

## Verification

- `tests/unit/match-score.spec.ts` — 45 tests, all passing, with expected numbers derived by
  hand and quoted in comments: weights sum; credit ladder incl. the AI gate; full-evidence
  score (`90/90`) and renormalized score (`84/56`) hand-computed; determinism; injected-clock
  freshness; AC-010 (unknown ≥ contradicted); ENG-028 (score fixed, confidence lower on a
  `PARTIAL` description); every factor's KNOWN/UNKNOWN/0 boundaries; hostile input
  (blank names, `NaN` years, invalid dates) returns `0/0` without throwing.
- Mutation checks (reported with the change): dividing by the total weight instead of the known
  weight, removing the `AI_SUGGESTED` confidence gate, and dropping the exclusive-remote
  penalty each fail the tests that pin them.
- `tests/integration/candidate-profile-repository.spec.ts` — 11 tests against a real PostgreSQL
  database: full round-trip of every stated field, whole-profile replace (a dropped skill/role
  is gone, not stale), profile-row id and `profileVersion` stability, one profile per user at the
  DB level, duplicate-skill rejection, two candidates in unrelated fields staying independent,
  and a stable list order across calls.
- `tests/unit/profile-version.spec.ts` — 4 tests: the revision is content-derived, independent of
  key and list order, and changes when a fact changes.
- Migration verified on an empty scratch database: `prisma migrate deploy` applies all 8
  migrations, then `prisma migrate diff --from-schema-datasource … --to-schema-datamodel …`
  reports **No difference detected** (exit 0).
