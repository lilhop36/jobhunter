# Source approval records

One Markdown file per job source. SRS Appendix E requires that, for each source, the product
owner records **approval**, the **access mechanism**, the **robots and terms review outcome**,
the **stable job identifier field**, and the **declared calendar and currency**. A source
without a recorded approval has no adapter.

## The rule

- A source has an adapter only when its record's `Status` is exactly `APPROVED`.
- `TEMPLATE.md` defaults to `Status: PENDING`. Copying it does not approve anything.
- Any other status (`PENDING`, `REJECTED`, or a missing `Status` line) means no adapter.
- Records are keyed by the source's `JobSource.name` (unique). The adapter registry declares
  which record a registration depends on, and `tests/unit/source-approval-records.spec.ts`
  fails if a registered adapter has no `APPROVED` record.

## Fields

| Field | Required by | Values |
|-------|-------------|--------|
| `Source` | this convention | the source's `JobSource.name` |
| `Status` | this convention / Appendix E approval | `PENDING` \| `APPROVED` | `REJECTED` |
| `Access mechanism` | Appendix E | `FEED` \| `API` | `STATIC_HTML` \| `BROWSER` (HTTP-first; `BROWSER` is a last resort) |
| `Robots and terms review` | Appendix E | free text: outcome and date |
| `Stable job identifier field` | Appendix E / ADR-0001 | the source's stable id field, or `none` |
| `Declared calendar` | Appendix E | `GREGORIAN` / `ETHIOPIAN` / `UNKNOWN` |
| `Declared currency` | Appendix E | ISO-4217 code, or `none` |
| `Canonical URL identity trusted` | ADR-0001 (`SourceAdapterConfig.canonicalUrlIdentityTrusted`) | `yes` / `no` |
| `Expected results` | ADR-0001 §4 (`SourceResultExpectation`) | `UNKNOWN` / `RESULTS_EXPECTED` / `ZERO_EXPECTED` |
| `Reviewed by`, `Review date` | traceability | name, `YYYY-MM-DD` |

The declared calendar, declared currency, canonical-URL trust, and expected results are the
per-source declarations `SourceAdapterConfig` and the collection use case already require with
no defaults; the record is where they come from, and the `PRODUCTION_ADAPTERS` registration
mirrors them for the runtime (ADR-0004).

## Creating a record

1. Copy `TEMPLATE.md` to `docs/sources/<source-slug>.md`.
2. Fill in every field from the review. Do not guess: an unknown value is `UNKNOWN`/`none`, never
   an invented fact.
3. Set `Status: APPROVED` only after the review is complete.
4. Register the adapter in `apps/worker/adapters.ts` (`PRODUCTION_ADAPTERS`) with a `sourceName`
   matching the record's `Source` and an `approvalRecord` naming this file. The
   `source-approval-records` test then fails if the record is missing or not `APPROVED`.

## Not covered here

How an approved source's `JobSource` row is created: run `npm run seed:sources`
(`scripts/seed-sources.mjs`), which upserts the EffoySira row — creates it when absent, never
overwrites the operational `enabled`/`schedule` fields. The runtime
mapping is settled: the worker's `resolveAdapter` (`createAdapterRegistryResolver` in
`apps/worker/adapters.ts`; ADR-0004) looks the row up by id, matches its `name` to a
`PRODUCTION_ADAPTERS` registration, and builds the adapter from that registration's
declarations plus the row's id.
