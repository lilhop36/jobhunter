# ADR-0002: Description-quality policy (`DESCRIPTION_QUALITY_V1`)

- **Status:** Approved 2026-10-16 (owner ratified the threshold, token basis, normalization, boilerplate rule, missing-description handling, and versioning). Implemented in increment "description-quality authority + source approval".
- **Date:** 2026-10-16
- **Relates to:** SRS v1.1 §3.5, §4.3, §7.7 (Description quality), Appendix A (`DescriptionQuality`), Appendix E; FR-007; ADR-0001
- **Blocks:** the matcher/notification exclusion of `UNUSABLE` jobs (Milestone 2) and every future real source adapter

## Why this decision needs its own record

The SRS requires descriptions to be classified `sufficient / partial / unusable` "using
configurable deterministic checks" (§3.5, §4.3, §7.7) and fixes the enum (Appendix A) and the
lifecycle (Appendix E), but **deliberately does not define the checks**. Every number and word
list below is therefore an engineering decision, not an SRS requirement. It must be recorded
and versioned because it is a load-bearing, tunable rule: `UNUSABLE` jobs are excluded from
matching and notification (Appendix E), so a threshold change silently changes which jobs the
owner can be told about.

## Decision

Description quality is a **pure, versioned, deterministic** function of the captured text,
applied by the shared ingestion pipeline. It is not source-specific and must not live in an
adapter (ENG-016).

### Rules (`DESCRIPTION_QUALITY_V1`), first match wins

| # | Condition | Result |
|---|-----------|--------|
| R0 | input is not a `string` (`null`, `undefined`, number, object, …) | `UNUSABLE` |
| R1 | blank after normalization (empty, whitespace-only, zero-width-only) | `UNUSABLE` |
| R2 | no token contains a Unicode letter (digits, punctuation, symbols, emoji only) | `UNUSABLE` |
| R3 | **every** letter-bearing token is in the boilerplate lexicon | `UNUSABLE` |
| R4 | fewer than **25** letter-bearing tokens | `PARTIAL` |
| R5 | otherwise | `SUFFICIENT` |

### Threshold — 25 letter-bearing tokens

- **Boundary:** 24 tokens → `PARTIAL`; 25 tokens → `SUFFICIENT`.
- **Counting basis:** only tokens containing a Unicode letter (`\p{L}`) are counted, so
  punctuation, digits, prices and symbols cannot inflate a description into `SUFFICIENT`.
- **Why 25:** a short paragraph. It is intentionally conservative. The two errors are
  asymmetric: a false `PARTIAL` only ranks a job down (it is still matched and notifiable),
  while a false `SUFFICIENT` spends the owner's attention on a posting with nothing to read.
  The value is a single knob, injected through the policy, so it can be re-tuned without
  touching the classifier.

### Normalization

Applied before the rules, so classification is stable across encodings and line endings:

1. Unicode NFKC;
2. remove `\p{Cf}` (zero-width space/joiners, BOM, soft hyphen, …);
3. collapse every whitespace run to a single space;
4. trim.

The classifier reads no clock, locale, or random source (ENG-012), so the same text always
yields the same result.

### Boilerplate behavior

R3 fires only when **every** lexical token is in the lexicon - navigation/page chrome and
unambiguous placeholder values (`home`, `login`, `apply`, `lorem`, `n/a`, `tbd`, …). It is
deliberately conservative: a genuine description that merely uses one of those words next to
real content is not `UNUSABLE` ("Apply directly" is `PARTIAL`). The cost is that a garbage page
mixing chrome with a stray brand token lands `PARTIAL`, not `UNUSABLE`; that is the safe
direction, because `PARTIAL` is visible and non-destructive.

### Missing and malformed descriptions

A missing (`null`), non-string, empty, or normalized-empty description is `UNUSABLE`. Appendix E
removes `UNKNOWN` from `descriptionQuality` and requires a value on every Job, so the enum cannot
represent "not collected". No evidence is lost by this collapse: `RawJob.rawDescription` keeps
`null` (missing) and `''` (empty) distinct, so the missing fact remains recoverable for
reprocessing (ENG-002). The derived label must not itself be read as "the posting has no
description"; the raw evidence is the authority for that.

### Versioning

The rules and lexicon are identified by `DESCRIPTION_QUALITY_VERSION`
(`DESCRIPTION_QUALITY_V1`). The pipeline stamps it into `Job.provenance.descriptionQuality
.conversionMethod` for every Job, so the recorded basis of a classification stays attributable
after the policy changes. Any change to a rule, the threshold, the lexicon, or normalization
bumps the version; old and new classifications are never compared as if equivalent.

## The pipeline is authoritative

`JobSourceAdapter.normalize` still populates `descriptionQuality` (the `NormalizedJob` contract
requires it), but the shared pipeline re-derives the field immediately before persistence via
`applyDescriptionQuality` and overwrites whatever the adapter supplied. Consequences:

- an adapter cannot promote an actually `UNUSABLE` description to `SUFFICIENT`, nor downgrade
  or upgrade it contrary to the policy;
- the recorded provenance always names the shared policy version, never an adapter's own rule;
- the classification describes the description that is actually persisted (`job.description`),
  which is the text a future matcher will read.

There is no second source of truth: the adapter's value is ignored, not merged.

## Consequences for the funnel (unchanged from ADR-0001)

An `UNUSABLE` description is **not** a collection-time rejection. Per Appendix E it is persisted
"for traceability and funnel metrics" and excluded from matching and notification:

| Stage | Behavior |
|-------|----------|
| Raw evidence | preserved (written before normalization) |
| `Job` | persisted, with `descriptionQuality = UNUSABLE` |
| `jobsRejected` | `0` (ADR-0001 §4/§5) |
| `valid` / `unique` | counted; collection rejects nothing |
| `active` | unaffected - lifecycle is about source presence, not text quality |
| `matched` / `notified` | **must exclude it** - deferred to Milestone 2 |

Because Jobs are upserted on identity, a re-collection can change `descriptionQuality`; when the
matcher lands it must re-evaluate the exclusion rather than remember a permanent rejection.

## Not decided here

- Matcher and notification exclusion logic (Milestone 2).
- Per-source regression fixtures (SRS §9.3) - deferred until the first real adapter exists.
- Whether a title-only (missing-description) posting should be notifiable. `UNUSABLE` is the
  ratified answer for now; changing it would be an SRS clarification, not an engineering tweak.
