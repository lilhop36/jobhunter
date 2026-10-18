# ADR-0003: Source enablement and approval semantics

- **Status:** Approved 2026-10-17 (owner approved Option A: reject manual runs of disabled sources with `409 SOURCE_DISABLED`; approval stays separate from `enabled`; no API approval state, no database column, no migration).
- **Date:** 2026-10-17
- **Relates to:** SRS v1.1 §3.4, §4.2 (FR-001/FR-002), §5.2 (`JobSource`), §7.6, §7.7, Appendix E; ENG-019; ADR-0001
- **Supersedes nothing.** Clarifies behaviour the SRS left undefined.

## Context

Two `JobSource` concepts gate collection and were under-specified for the manual-run
endpoint:

1. **`enabled`** (SRS §5.2). The SRS ties it to scheduled collection (§4.2: "Enabled sources
   shall be collected on schedule") and to source management, but never says what a **manual**
  run does for a disabled source.
- The scheduler honours it: `PrismaJobSourceRepository.listSchedulable` selects
  `WHERE enabled = true`, and `SourceScheduler` further skips sources with no schedule or an
  unparseable one.
- `POST /api/sources/:id/run` did **not** check it. `GET /api/sources` hides disabled sources
  by default, but the run endpoint accepted any known id, so a disabled source could be
  collected manually — writing real `source_runs` and `healthStatus` state for a source the
  operator had taken out of service.

2. **Approval.** Appendix E and ENG-019 require a source to be approved, with its access
   mechanism recorded, *before an adapter is written*, and state "a source without a recorded
  approval has no adapter". Approval is therefore a documentation fact (`docs/sources/*.md`),
  not stored state: there is no `approved` column, and `JobSource.accessPolicy` (JSONB) is
  inert. Its one runtime consequence is that no adapter exists.

The SRS fixed only one manual-run rule — §3.4, "If a source is already active, the API returns
conflict" — so both of the above were undefined.

## Decision

**1. `enabled` governs all collection, scheduled and manual.** A disabled source is out of
service and is never collected. `enabled` is an operator opt-in, not merely a scheduling flag.

A manual run of a disabled source is refused with:

```
HTTP 409
{ "error": { "code": "SOURCE_DISABLED", "message": "Source is disabled", "details": { "sourceId": "<id>" } } }
```

`SOURCE_DISABLED` is a new code in the SRS §3.4 error envelope, alongside `SOURCE_RUN_ACTIVE`.
The refusal is a 409 because the request is well-formed but conflicts with the source's
current state, exactly as the active-run refusal does.

**Guard order.** Enablement is checked **before** the active-run conflict. Enablement decides
*whether* a run may start; the active-run check decides *how* one starts, and only applies to
a source that is allowed to run at all. A disabled source therefore always reports
`SOURCE_DISABLED`, even when a run is already in flight.

**Approval is not a runtime flag.** Per Appendix E, approval is the existence of an adapter.
The API does not store, query, or infer it:
- no `approved` column, no migration, no API-level approval state;
- an unapproved source (no adapter) that is somehow collected fails permanently at adapter
  resolution with `no adapter is configured for source <id>`, visible in the run's
  `errorSummary`;
- `JobSource.accessPolicy` remains the *recorded* approved access mechanism (Appendix E). It
  is not published by the API and is not an authorization input.

Separating the two is deliberate: `enabled` is runtime state the API owns; approval is a
human decision recorded in `docs/sources`. Duplicating approval into the database would
create a second source of truth that can silently disagree with the signed record.

## Collection entry points (analyzed)

| Path | Enforced? | How |
|------|-----------|-----|
| Scheduled collection | **Yes** | `listSchedulable()` selects `enabled = true`; the scheduler never considers a disabled source (SRS §4.2) |
| `POST /api/sources/:id/run` | **Yes (this ADR)** | Guard returns `409 SOURCE_DISABLED` before the active-run check |
| Worker task handler (`source.collection` task) | **No** | It resolves an adapter for whatever `sourceId` is in the payload; it does not re-check `enabled` |

**Residual (known limitation).** A task enqueued while a source was enabled, then disabled
before a worker claims it, is still collected. The handler would have to read `JobSource` on
every claim to close this window, which is not part of this decision; the window is bounded by
the claim latency and is visible in run history. A future ADR may add a
`enabled` re-check at claim time if it proves material.

## Consequences

- A disabled source cannot be collected by schedule or by a manual run.
- A manual run of a disabled source is refused synchronously, with the standard error
  envelope, and enqueues no work task.
- Approval behaviour is unchanged; the "no adapter" permanent failure remains the only
  approval enforcement.
- No schema change and no migration.

## Verification

- `tests/integration/api-sources.spec.ts`: disabled → `409 SOURCE_DISABLED` with the envelope
  and no enqueued task; disabled + active run → `SOURCE_DISABLED` (guard order); enabled → 202;
  unknown → 404.
- `tests/integration/source-scheduler.spec.ts` (`skips disabled sources`) covers the scheduled
  path independently.
