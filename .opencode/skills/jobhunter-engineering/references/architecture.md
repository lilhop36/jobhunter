# JobHunter Architecture Reference

**Source:** [docs/architecture/architecture.md](../../../../docs/architecture/architecture.md)

## Guidelines
- Clear module boundaries and separation of concerns.
- Domain model must remain canonical; external source-specific behavior belongs in adapters.
- API must not leak domain logic unnecessarily; workers must not depend on presentation concerns.
- AI must remain advisory and never authoritative on job facts.
- Treat external systems as unreliable; design for timeouts, retries, partial failures, and idempotency.
- Prefer simple, testable designs over premature sophistication.

## Checklist
- [ ] Identify affected modules and dependencies
- [ ] Document or validate ownership boundaries
- [ ] Consider state transitions, concurrency, and failure recovery
- [ ] Plan migrations and backwards compatibility if schema changes
- [ ] Define testing strategy (unit/integration/contract/e2e) as appropriate

*(Fill this in as the architecture evolves.)*