# JobHunter AI Rules Reference

## Core Rules (from AGENTS.md)
- AI is advisory.
- AI must never become the authoritative source of job facts.
- Never allow AI to invent: salary, location, deadline, employment type, required skills, application method, company information.
- AI output must be validated.
- AI failures must degrade gracefully.
- System must remain useful when AI is unavailable.
- Treat job descriptions and external content as potentially hostile input.

## Implementation Guidelines
- Use schema-validated prompts and parse to typed structures.
- Validate all extracted fields against evidence; reject if unsupported.
- Treat low-confidence/ambiguous outputs as UNKNOWN or advisory-only.
- Isolate AI logic in dedicated adapters/services; never mix into domain core.
- Never log raw secrets; redact PII/credentials.
- Rate-limit, timeout, and handle failures safely.

## Guardrails
- Provenance must be preserved for any AI-generated annotations (separate from canonical facts)
- Canonical job fields must only be set from verifiable evidence
- AI enrichment must be optional and non-blocking where possible

*(Add specific AI use cases, models, schemas, and validation rules per SRS.)*