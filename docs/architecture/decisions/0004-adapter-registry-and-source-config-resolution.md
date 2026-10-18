# ADR-0004: Adapter registry and the source-row to adapter-config mapping

- **Status:** Accepted 2026-10-17
- **Relates to:** SRS §7.2, §7.7, Appendix E; ENG-016; ADR-0001; ADR-0002; ADR-0003
- **Supersedes nothing.** Resolves the wiring decision ADR-0002's increment left open ("how
  the worker maps a source id to its record at runtime").

## Context

SRS 7.2 / Appendix E make source approval a precondition for a connector: "a source without
a recorded approval has no adapter". The approval convention (`docs/sources/*.md`) and the
registry seam (`apps/worker/adapters.ts`, `PRODUCTION_ADAPTERS`) already exist, with a test
that fails when a registration has no APPROVED record. But the worker's `resolveAdapter` was
a hard-coded `async () => null`, so the registry was never consulted, and two questions were
deliberately left open:

1. `resolveAdapter` receives a source **id** (UUID); approvals are keyed by source **name**.
2. `SourceAdapterConfig` requires per-source declarations (access mechanism, declared
   calendar/date format/currency, canonical-URL trust, options) that exist in neither the
   `JobSource` row nor any typed column — only in the signed approval record, and the
   records are documentation, not runtime data.

## Decision

**The registry is the runtime source of an approved source's adapter and declarations.**

`createAdapterRegistryResolver` (in `apps/worker/adapters.ts`) is the worker's production
`resolveAdapter`:

1. Look the source up by id (`JobSourceRepository.findById`).
2. Match the row's **name** against the registrations; a source with no matching
   registration resolves null, which the collection handler reports as the existing
   permanent failure ("no adapter is configured for source \<id\>").
3. Build the adapter from the registration's `config` declarations plus the row's id.

The declarations live **in code, in the registration**, mirroring the approved record.
They are not parsed from the Markdown at runtime: the record is a signed review document,
and a declaration that changes must change under review in the same commit as the record it
mirrors. This keeps one runtime path, and the `source-approval-records` unit test keeps the
mirroring honest for the parts it can check (record exists, reads APPROVED, name matches).

The registry is empty today, so **runtime behaviour is unchanged**: with no registrations the
resolver returns null without querying the database, exactly as the previous hard-coded
stub. Adding a real source becomes a registration plus its record — not a change to the
worker entry point or runtime.

Not decided here, deliberately: how an approved source's `JobSource` row is created (no seed
exists yet), and whether the worker should re-check `enabled` at claim time (ADR-0003
residual). Neither blocks the registry.

## Consequences

- `WorkerRuntimeDeps.resolveAdapter` is optional: production gets the registry resolver,
  tests keep injecting the fake adapter, and nothing else changes.
- A mismatch between a row's name and its registration is the operational signal, not a
  second database flag: the collection fails permanently with the explicit "no adapter"
  error and the run records it.
- `JobSource.accessPolicy` stays inert; it records the approved access mechanism for review
  and is not consulted at runtime.

## Verification

- `tests/unit/source-approval-records.spec.ts` gains a resolver suite: approved name →
  adapter built from the row's id and the registration's declarations; unregistered name →
  null; unknown id → null; default is `PRODUCTION_ADAPTERS`; an empty registry never
  queries.
- Full suite and `tsc --noEmit` run after the change (see the increment report).
