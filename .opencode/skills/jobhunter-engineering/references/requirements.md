# JobHunter Requirements Reference

**Source of Truth:** [docs/SRS/JobHunter-v1.0-SRS.md](../../../../docs/SRS/JobHunter-v1.0-SRS.md)

## Purpose

This file captures high-level requirement anchors for quick reference. It is not a substitute for reading the full SRS.

## Key Principles
- Data-quality first (UNKNOWN is valid, no fabrication)
- AI advisory only (never authoritative on factual job data)
- Deterministic, explainable matching
- Security and least privilege
- External data treated as untrusted

## Required Sections to Track
When implementing a feature, locate and satisfy:
- Functional Requirements (FR-*)
- Non-Functional Requirements (NFR-*)
- Business Rules (BR-*)
- Acceptance Criteria (AC-*)
- Data Model / Entities
- Constraints & Assumptions

## Reminder
If the SRS is ambiguous, identify the ambiguity and do not proceed to a major architectural decision until clarified. See AGENTS.md for the full workflow.