# JobHunter Architecture

> **Status:** Placeholder
>
> Document system boundaries, modules, data flow, and design decisions here. Keep canonical domain model clean and isolate external sources via adapters.

## Goals
- Clear separation of concerns
- Data-quality first
- Deterministic, explainable matching
- AI advisory only
- Secure and testable
- Resilient to unreliable external systems

## High-Level Structure (suggested)
- Domain: canonical entities, business rules, matching logic (deterministic)
- Application: use cases/services (orchestrate, no leakage)
- Adapters: external sources, AI, notifications (isolate source-specific behavior)
- Infrastructure: persistence, workers, config, logging (redact secrets)
- API/Interface: thin boundary, no domain logic
- Workers: background processing, idempotent, retries

## Data Flow Principles
- External data ingested via adapters -> normalized to canonical domain model with provenance
- Canonical facts never overwritten by unverified AI output
- AI annotations stored separately with evidence/traces
- Matching is deterministic; AI signals advisory only

## Key Decisions
Record significant decisions in [decisions/](decisions/).

## Open Questions
Track architectural unknowns here.