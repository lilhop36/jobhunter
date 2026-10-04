# JobHunter Data Quality Reference

## Core Rules (from AGENTS.md)
- Never fabricate job information.
- Preserve source provenance.
- Treat externally collected content as untrusted input.
- UNKNOWN is a valid state.
- Do not convert UNKNOWN → false.
- Do not convert missing evidence → negative evidence.
- Do not infer facts merely because they appear likely.

## Data Quality Checks
- Provenance fields must be populated for externally sourced records (source, source_url, fetched_at, etc.)
- Required fields must not be silently defaulted to false/null to satisfy constraints
- Normalization must not erase uncertainty
- Deduplication must prefer evidence-based decisions
- Validation must reject fabricated values

## Validation Examples
- Location: UNKNOWN if cannot be determined with evidence
- Salary: UNKNOWN unless explicitly stated with evidence
- Deadline: UNKNOWN unless verifiable
- Employment type: UNKNOWN unless clearly specified

*(Add concrete field definitions and constraints from the SRS as they become available.)*