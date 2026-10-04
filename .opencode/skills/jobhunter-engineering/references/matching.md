# JobHunter Matching Reference

## Principles (from AGENTS.md)
- Matching must remain deterministic and explainable.
- AI must not silently replace deterministic matching logic.
- A match score is not the same thing as confidence.
- Every important matching decision must have an explainable basis.
- Changes to scoring rules require tests.

## Guidelines
- Base rules on explicit evidence from job description and candidate profile.
- Explainable factors: e.g., required skills match, location constraints, employment type, visa constraints, etc.
- Score components should be auditable (what contributed, weights, thresholds).
- AI may provide advisory signals only; they must not override deterministic logic without explicit, traceable rationale.
- Unknowns must propagate (do not force a match/deny).

## Testing Requirements
- Unit tests for scoring rules and edge cases (UNKNOWN states)
- Regression tests for any rule change
- Tests covering tie-breaking, ambiguity, and missing evidence

*(Document concrete rule set, weights, and explainability schema from SRS/architecture.)*