**JOBHUNTER v1.0  
Software Requirements Specification**  
Industry-Standard Structured Edition

Pragmatic MVP — Ethiopia-first, single-user, data-quality-first  
job discovery and notification system

| Document Type       | Software Requirements Specification |
|---------------------|-------------------------------------|
| Version             | 1.1                                 |
| Status              | Implementation Baseline             |
| Stage               | MVP / Validation                    |
| Primary User        | One seeded candidate                |
| Primary Channel     | Telegram                            |
| Database            | PostgreSQL                          |
| Worker              | Separate Node.js worker process     |
| AI                  | Optional, on-demand, advisory       |
| Primary KPI         | Notification Precision              |
| Geographic Priority | Ethiopia → Remote → International   |

# Document Control

| Version | Date       | Change                                                                                                                                                         | Status                   |
|---------|------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------|
| 1.0     | 2026-10-04 | Reorganized into a conventional industry SRS structure while preserving v1.0 product requirements.                                                             | Baseline                 |
| 1.1     | 2026-10-13 | Completed Section 14 Engineering Rules; added enums to Appendix A; added Appendix E implementation clarifications. No v1.0 requirement was removed or changed. | Draft for owner approval |

Document basis: This edition restructures the uploaded JobHunter v1.0 Full SRS. Product scope, decisions, requirements, constraints, and acceptance criteria are retained; the principal change is organization into a conventional SRS hierarchy.

# Table of Contents

> 1\. Introduction
>
> 1.1 Purpose
>
> 1.2 Scope
>
> 1.3 Product Definition
>
> 1.4 Problem Statement
>
> 1.5 Product Vision
>
> 1.6 Goals
>
> 1.7 Non-Goals
>
> 1.8 Definitions and Acronyms
>
> 1.9 Reference Basis
>
> 2\. Overall Description
>
> 2.1 Product Perspective
>
> 2.2 Users and Operating Model
>
> 2.3 Product Principles
>
> 2.4 System Scope and Boundaries
>
> 2.5 Operating Environment
>
> 2.6 Assumptions and Constraints
>
> 2.7 Deferred Infrastructure
>
> 3\. External Interface Requirements
>
> 3.1 User Interface
>
> 3.2 Telegram Interface
>
> 3.3 Web Application Interface
>
> 3.4 REST API Interface
>
> 3.5 Job Source Interfaces
>
> 3.6 AI Provider Interface
>
> 3.7 Database and Persistence Interface
>
> 4\. System Features and Functional Requirements
>
> 4.1 Functional Requirements Overview
>
> 4.2 Source Management and Collection
>
> 4.3 Data Fidelity, Normalization, and Validation
>
> 4.4 Deduplication and Job Lifecycle
>
> 4.5 Candidate Profile and Preferences
>
> 4.6 Deterministic Matching
>
> 4.7 AI-Assisted Extraction
>
> 4.8 Notification and Feedback
>
> 4.9 Health, Backup, and Recovery
>
> 5\. Data Requirements
>
> 5.1 Domain Entities
>
> 5.2 Entity Attributes
>
> 5.3 Data Integrity
>
> 5.4 Provenance and Evidence
>
> 5.5 Ethiopian Market Data Rules
>
> 5.6 Database Requirements
>
> 5.7 Migration Requirements
>
> 6\. Non-Functional Requirements
>
> 6.1 Performance
>
> 6.2 Reliability and Recovery
>
> 6.3 Maintainability
>
> 6.4 Scalability
>
> 6.5 Accessibility
>
> 6.6 Bandwidth Efficiency
>
> 6.7 Determinism
>
> 6.8 AI Independence
>
> 7\. System Architecture and Operational Requirements
>
> 7.1 High-Level Architecture
>
> 7.2 Process Separation
>
> 7.3 Worker Responsibilities
>
> 7.4 API Responsibilities
>
> 7.5 Durable Work and Locking
>
> 7.6 Scheduling, Catch-Up, and Retry
>
> 7.7 Ingestion Pipeline
>
> 7.8 Observability and Drift Detection
>
> 8\. Security and Privacy Requirements
>
> 8.1 Authentication
>
> 8.2 Authorization and Ownership
>
> 8.3 Secrets Management
>
> 8.4 External AI Privacy
>
> 8.5 Logging and Data Exposure
>
> 8.6 Source Security
>
> 8.7 AI Safety Boundaries
>
> 9\. Testing and Verification Requirements
>
> 9.1 Unit Testing
>
> 9.2 Integration Testing
>
> 9.3 Real-Data Fixtures
>
> 9.4 Determinism
>
> 9.5 Failure Testing
>
> 9.6 Regression Expectations
>
> 10\. Validation and Acceptance Requirements
>
> 10.1 MVP KPIs
>
> 10.2 Validation Period
>
> 10.3 Validation Question
>
> 10.4 Threshold Policy
>
> 10.5 Acceptance Criteria
>
> 11\. Implementation and Release Plan
>
> 11.1 Milestone 1 — Core Job Pipeline
>
> 11.2 Milestone 2 — Deterministic Matching
>
> 11.3 Milestone 3 — Telegram Loop
>
> 11.4 Milestone 4 — AI Fallback
>
> 11.5 Milestone 5 — Reliability and Validation
>
> 12\. Post-MVP Roadmap
>
> 13\. Risks and Mitigations
>
> 14\. Engineering Rules
>
> 14.1 Data Integrity and Evidence
>
> 14.2 AI Boundary
>
> 14.3 Determinism and Versioning
>
> 14.4 Architecture and Boundaries
>
> 14.5 Persistence, Queue, and Time
>
> 14.6 Numeric Units
>
> 14.7 Testing, Verification, and Change Control
>
> Appendix A. Core Enums
>
> Appendix B. Example Data Objects
>
> Appendix C. Definition of Done

# 1. Introduction

## 1.1 Purpose

This SRS defines the requirements for JobHunter v1.0, a single-user, Ethiopia-first job discovery and notification system. It serves as the authoritative implementation specification for the MVP.

## 1.2 Scope

The MVP continuously collects jobs from a deliberately small set of reliable and permitted sources, preserves raw evidence, normalizes and validates listings, removes duplicates and unusable opportunities, extracts structured fields deterministically, optionally uses AI for ambiguous cases, compares jobs against one candidate profile, and delivers high-confidence opportunities through Telegram.

## 1.3 Product Definition

JobHunter v1.0 is a single-user, Ethiopia-first job discovery and filtering system built around a trustworthy job-data pipeline, deterministic matching, and optional AI-assisted extraction.

Collect → Clean → Verify → Structure → Match → Explain → Notify → Measure

## 1.4 Problem Statement

Job opportunities are fragmented across job boards, company pages, permitted public channels, PDFs, and other sources. Listings may be duplicated, expired, poorly structured, missing salary information, ambiguous about location, or difficult to compare with a candidate profile. Manually checking these sources consumes time and attention.

## 1.5 Product Vision

JobHunter should behave like a disciplined personal job-search assistant: discover opportunities broadly enough to be useful, filter aggressively enough to reduce noise, and explain every delivered match using evidence.

## 1.6 Goals

- Collect from 3–5 actively maintained sources.

- Preserve raw source evidence.

- Normalize URLs, text, dates, salary, location, title, and company.

- Detect duplicate jobs.

- Detect unusable/dead application targets.

- Support Ethiopian and Gregorian dates without guessing.

- Represent local salary states such as NEGOTIABLE and AS_PER_SCALE.

- Match jobs deterministically against one candidate profile.

- Separate compatibility score from confidence.

- Explain matched, missing, and uncertain evidence.

- Use AI only when deterministic extraction is insufficient.

- Deliver actionable Telegram notifications.

- Measure notification usefulness over real-world use.

## 1.7 Non-Goals

- Public multi-user SaaS in v1.0.

- Large-scale source coverage.

- AI-generated job facts.

- AI as authoritative matcher.

- pgvector/vector ranking.

- Redis/BullMQ.

- Automatic CV parsing.

- Cover-letter generation.

- Full application lifecycle.

- Email channel.

- Social login.

- Mobile application.

- Paid AI dependency.

## 1.8 Definitions and Acronyms

| Term    | Meaning                                                    |
|---------|------------------------------------------------------------|
| SRS     | Software Requirements Specification                        |
| MVP     | Minimum Viable Product                                     |
| AI      | Artificial Intelligence                                    |
| API     | Application Programming Interface                          |
| KPI     | Key Performance Indicator                                  |
| NFR     | Non-Functional Requirement                                 |
| HTTP    | Hypertext Transfer Protocol                                |
| RSS     | Really Simple Syndication                                  |
| URL     | Uniform Resource Locator                                   |
| LLM     | Large Language Model                                       |
| UNKNOWN | A valid state when required evidence cannot be established |

## 1.9 Reference Basis

Primary source: uploaded “JobHunter v1.0 — Full SRS”, Version 1.0, dated 2026-10-04. No additional external product requirements are introduced by this restructuring.

# 2. Overall Description

## 2.1 Product Perspective

The system is a personal job-search pipeline with source adapters, a persistent PostgreSQL coordination/data layer, a separate worker process for heavy background work, a web interface for inspection and profile management, Telegram for notifications, and optional AI providers for ambiguous extraction cases.

The primary processing flow is:

Job Sources → Source Adapters → RawJob → Deterministic Normalization → Field Fidelity → Deterministic Extraction → AI Fallback (only when triggered) → Structured Evidence → Deduplication + Lifecycle → Deterministic Matcher → Match + Confidence + Explanation → Notification Outbox → Telegram → User Feedback → Precision Measurement

## 2.2 Users and Operating Model

## Primary user

One seeded candidate owns one profile and one Telegram destination.

## Multi-user readiness

Ownership fields such as userId shall remain in the schema where useful. Registration, invitation, multi-user administration, dormant-user processing, and multi-user notification policies are deferred.

## Operator

The developer/operator may inspect source health, worker runs, errors, and system configuration. This does not require a large customer-facing admin dashboard.

## 2.3 Product Principles

- Data quality first — bad structured data produces bad matches.

- Deterministic first — clear information is handled by reproducible rules.

- AI is advisory — it produces evidence, not authoritative facts or final decisions.

- Unknown is valid — unknown information must not be silently treated as negative evidence.

- Evidence before claims — important values retain provenance.

- Score is not confidence — compatibility and evidence completeness are different dimensions.

- Graceful degradation — AI, a source, or Telegram can fail without destroying the pipeline.

- Attention is the product — useful alerts matter more than alert volume.

- Scope follows validation — infrastructure and features are justified by measured bottlenecks.

## 2.4 System Scope and Boundaries

The v1.0 boundary is intentionally narrow: one seeded candidate, one Telegram destination, a small set of actively maintained sources, PostgreSQL-backed durable work, and a deterministic matching/notification loop. Broader platform capabilities are deferred until validation demonstrates a need.

## 2.5 Operating Environment

- Primary user: one seeded candidate.

- Primary channel: Telegram.

- Persistent database: PostgreSQL.

- Backend API: NestJS.

- Background processing: separate Node.js worker process.

- AI: optional, on-demand, advisory; local Ollama or optional external HTTP provider.

- Client interface: web application.

- Geographic priority: Ethiopia → Remote → International.

## 2.6 Assumptions and Constraints

- The MVP is intentionally single-user.

- Only a deliberately small set of actively maintained sources is targeted.

- Core usefulness must not depend on AI availability.

- The system must respect source access policies and must not bypass authentication, CAPTCHA, access controls, anti-bot mechanisms, or source restrictions.

- The source SRS defers Redis/BullMQ, pgvector/vector ranking, automatic CV parsing, cover-letter generation, full application lifecycle, email, social login, mobile application, and paid AI dependency.

## 2.7 Deferred Infrastructure

Redis/BullMQ is not required in v1.0. A PostgreSQL-backed work model is sufficient for the single-user MVP. Later queue infrastructure must preserve domain semantics.

# 3. External Interface Requirements

## 3.1 User Interface

## Required routes

- /dashboard

- /jobs

- /jobs/:id

- /matches

- /profile

- /settings

- /settings/telegram

## Dashboard

The dashboard prioritizes new matches, high-confidence opportunities, notification status, and basic source health.

## Match detail

Show score, confidence, factor breakdown, matched skills, missing skills, uncertain fields, source, salary, location, description quality, and application path.

## Provenance

Source-provided, deterministic, and AI-derived fields must remain distinguishable.

## Low bandwidth

Avoid unnecessary large assets and payloads. Defer non-essential content.

## Accessibility

Core workflows should be keyboard accessible, touch-friendly, semantically labeled, and not dependent on color alone.

## 3.2 Telegram Interface

## Linking

Telegram shall be linked using a secure short-lived deep-link token. The token must not encode private profile data.

## Eligibility

ACTIVE  
AND usable application target  
AND not already notified for equivalent event  
AND score \>= threshold  
AND confidence \>= threshold  
AND not suppressed/rejected

## Content

- Job title

- Company

- Location

- Score

- Confidence

- Why it matches

- Matched skills

- Missing/uncertain evidence

- Salary when known

- Application action

- Source

## Actions

VIEW \| SAVE \| REJECT \| APPLY / OPEN / COPY EMAIL

## Rate limits

Telegram failures and 429 responses shall be handled by persistent outbox retry/backoff. Notification failure must not delete the underlying match.

## Duplicate notification

The same qualifying job event shall not be delivered repeatedly unless an explicitly supported material-change event occurs.

## 3.3 Web Application Interface

The web application exposes the required routes, dashboard, match detail, provenance, low-bandwidth behavior, and accessibility behaviors specified in the source SRS.

## 3.4 REST API Interface

## Core endpoints

| **Method** | **Endpoint**                    | **Purpose**         |
|------------|---------------------------------|---------------------|
| GET        | /api/jobs                       | List jobs           |
| GET        | /api/jobs/:id                   | Job detail          |
| GET        | /api/matches                    | List matches        |
| GET        | /api/matches/:id                | Match evidence      |
| GET        | /api/profile                    | Candidate profile   |
| PUT        | /api/profile                    | Update profile      |
| GET        | /api/notifications              | Notifications       |
| POST       | /api/notifications/:id/feedback | Feedback            |
| POST       | /api/telegram/link              | Telegram link token |
| GET        | /api/sources                    | Source health       |
| POST       | /api/sources/:id/run            | Manual source run   |

## Manual run

If a source is already active, the API returns conflict rather than creating concurrent work.

A manual run of a disabled source returns conflict with error code `SOURCE_DISABLED`; a disabled source is never collected, whether by schedule or by a manual run.

## Error format

{  
"error": {  
"code": "SOURCE_RUN_ACTIVE",  
"message": "Source collection is already running"  
}  
}

## 3.5 Job Source Interfaces

interface JobSourceAdapter {  
collect(context): Promise\<RawJob\[\]\>;  
normalize(raw): Promise\<NormalizedJob\>;  
healthCheck(context): Promise\<HealthResult\>;  
}

HTTP/API/RSS/static parsing shall be attempted before browser automation. Playwright is a last resort for sources that genuinely require client-side rendering.

The system shall not bypass authentication, CAPTCHA, access controls, anti-bot mechanisms, or source restrictions. Rate limits and source rules must be respected.

Descriptions shall be classified as sufficient, partial, or unusable using configurable deterministic checks.

ONLINE_URL \| EMAIL \| SOURCE_ACCOUNT \| PDF_FORM \| IN_PERSON \| INSTRUCTIONS \| UNKNOWN

A job must have a usable application path before notification unless the notification policy explicitly permits informational listings.

## 3.6 AI Provider Interface

AiProvider  
├── OllamaProvider  
├── ExternalHttpProvider (optional)  
└── NoopProvider

- Ambiguous skill extraction

- Low-confidence role interpretation

- Ambiguous seniority

- Ambiguous remote/location wording

- Difficult structured extraction

- Evidence-backed explanation generation from existing facts

AI output shall be parsed and schema-validated before use. Invalid output becomes a typed AI failure.

AiEvidence  
jobId  
provider  
model  
schemaVersion  
promptVersion  
field  
value  
confidence  
evidence  
status  
createdAt

## 3.7 Database and Persistence Interface

## Canonical database

PostgreSQL is the canonical v1.0 database.

## Integrity

Use foreign keys, unique constraints, indexes, transactions, and explicit lifecycle states.

## Recommended indexes

- Job(canonicalUrl)

- Job(contentFingerprint)

- Job(sourceId,lifecycleStatus)

- Job(publishedAt)

- JobMatch(userId,score)

- JobMatch(userId,jobId) UNIQUE

- NotificationOutbox(status,nextAttemptAt)

- SourceRun(sourceId,startedAt)

- CandidateSkill(candidateProfileId,canonicalSkill) UNIQUE

## Migrations

Schema changes must use versioned migrations. Destructive migrations require a verified backup.

# 4. System Features and Functional Requirements

## 4.1 Functional Requirements Overview

The following FR identifiers and wording are the authoritative functional baseline carried forward from the source SRS.

| **ID** | **Area**       | **Requirement**                                                                       |
|--------|----------------|---------------------------------------------------------------------------------------|
| FR-001 | Sources        | Represent enabled sources, adapter type/version, schedule, access policy, and health. |
| FR-002 | Collection     | Collect enabled sources on schedule.                                                  |
| FR-003 | Isolation      | A source failure must not stop other sources.                                         |
| FR-004 | Raw data       | Preserve source evidence sufficient for debugging/reprocessing.                       |
| FR-005 | Normalization  | Normalize every collected job before matching.                                        |
| FR-006 | URLs           | Normalize and verify application targets.                                             |
| FR-007 | Description    | Classify description quality and reject/flag unusable content.                        |
| FR-008 | Deduplication  | Detect duplicates using multiple signals.                                             |
| FR-009 | Extraction     | Extract key fields deterministically when possible.                                   |
| FR-010 | AI             | Invoke AI only for explicit ambiguity/missing-data triggers.                          |
| FR-011 | Provenance     | Retain provenance/evidence for important fields.                                      |
| FR-012 | Profile        | Maintain one candidate matching profile.                                              |
| FR-013 | Matching       | Calculate reproducible deterministic match score.                                     |
| FR-014 | Confidence     | Calculate evidence/extraction confidence separately.                                  |
| FR-015 | Explainability | Expose matched, missing, and uncertain evidence.                                      |
| FR-016 | Notifications  | Notify only eligible active jobs.                                                     |
| FR-017 | Outbox         | Use persistent notification delivery state.                                           |
| FR-018 | Feedback       | Record relevant/not relevant/unsure feedback.                                         |
| FR-019 | Lifecycle      | Detect expired, removed, and dead jobs.                                               |
| FR-020 | Health         | Detect abnormal source behavior.                                                      |
| FR-021 | Backup         | Run scheduled database backups.                                                       |
| FR-022 | Recovery       | Recover persistent worker work after restart.                                         |

## 4.2 Source Management and Collection

Enabled sources shall be represented with adapter type/version, schedule, access policy, and health. Enabled sources shall be collected on schedule, and a source failure must not stop other sources.

## 4.3 Data Fidelity, Normalization, and Validation

Collected jobs shall preserve raw evidence, be normalized before matching, have application targets normalized and verified, and have description quality classified using configurable deterministic checks. Important fields retain provenance.

## 4.4 Deduplication and Job Lifecycle

The system shall detect duplicates using multiple signals and detect expired, removed, and dead jobs. A job must have a usable application path before notification unless notification policy explicitly permits informational listings.

## 4.5 Candidate Profile and Preferences

The system shall maintain one candidate matching profile. The source model includes candidate skills, target roles, location preferences, experience, remote preference, relocation preference, salary preference, employment preferences, and profile version.

## 4.6 Deterministic Matching

## Initial weights

| **Factor** | **Weight** |
|------------|------------|
| Role       | 25%        |
| Skills     | 30%        |
| Experience | 15%        |
| Location   | 15%        |
| Employment | 5%         |
| Freshness  | 5%         |
| Salary     | 5%         |

Weights are a versioned initial hypothesis. They must be evaluated against real notifications.

## Skill credit

| **Evidence**    | **Credit policy**           |
|-----------------|-----------------------------|
| EXACT_MATCH     | Full credit                 |
| CANONICAL_ALIAS | Full credit                 |
| RELATED_SKILL   | Partial, capped             |
| TRANSFERABLE    | Lower partial, capped       |
| AI_SUGGESTED    | Confidence-gated and capped |
| UNKNOWN         | No positive credit          |

## UNKNOWN rule

UNKNOWN is not automatically a failure. A factor with unknown evidence may be excluded from the denominator and the known weights renormalized. Confidence/evidence completeness must decrease.

FinalScore = sum(known score × weight) / sum(known weights)

## Salary

Known salary may participate in salary preference scoring. Negotiable, as-per-scale, not-disclosed, and unknown salary shall normally be excluded from the salary denominator unless the candidate explicitly requires disclosed salary.

## Remote

Remote preference shall positively affect remote opportunities when remote is preferred/required and reject or penalize onsite jobs only when onsite is excluded.

## Confidence

Confidence measures evidence completeness and extraction certainty. It is not another relevance score.

## Versioning

Every JobMatch stores matcherVersion. Changes to weights, thresholds, or scoring logic require a new version.

## 4.7 AI-Assisted Extraction

## Providers

AiProvider  
├── OllamaProvider  
├── ExternalHttpProvider (optional)  
└── NoopProvider

## v1.0 AI use cases

- Ambiguous skill extraction

- Low-confidence role interpretation

- Ambiguous seniority

- Ambiguous remote/location wording

- Difficult structured extraction

- Evidence-backed explanation generation from existing facts

## Prohibitions

- No invented employer/salary/location/deadline/skill/application data.

- No silent overwrite of stronger source evidence.

- No notification solely because AI says a job is good.

- No external AI transmission of private candidate data without explicit configuration/consent.

- No hard dependency on AI for collection or core matching.

## Explicit triggers

Call AI only when one or more conditions apply:  
- no skills detected despite substantial description;  
- role confidence below configured threshold;  
- remote/location wording ambiguous;  
- seniority ambiguous;  
- critical field remains UNKNOWN;  
- recoverable description is difficult to structure.

## Limits

AI_PROVIDER=noop\|ollama\|external  
AI_ANALYSIS_TIMEOUT_MS=15000  
AI_ANALYSIS_MAX_PER_RUN=50

## Structured output

AI output shall be parsed and schema-validated before use. Invalid output becomes a typed AI failure.

## Prompt injection

Job descriptions are untrusted data. Source text must never be treated as system instructions. Prompt boundaries must explicitly identify source content as data.

## AI evidence

AiEvidence  
jobId  
provider  
model  
schemaVersion  
promptVersion  
field  
value  
confidence  
evidence  
status  
createdAt

## 4.8 Notification and Feedback

The system shall notify only eligible active jobs, persist notification delivery state in an outbox, prevent repeated equivalent events, and record relevant/not relevant/unsure user feedback. Telegram failures and 429 responses shall trigger persistent retry/backoff without deleting the underlying match.

## 4.9 Health, Backup, and Recovery

The system shall detect abnormal source behavior, run scheduled database backups, recover persistent worker work after restart, and preserve notification/match state across transient Telegram failures.

# 5. Data Requirements

## 5.1 Domain Entities

- User

- CandidateProfile

- CandidateSkill

- TargetRole

- LocationPreference

- JobSource

- SourceRun

- RawJob

- Job

- JobSkill

- AiAnalysisRequest

- AiEvidence

- JobMatch

- NotificationOutbox

- NotificationFeedback

- SystemLog

- BackupRun

## 5.2 Entity Attributes

### User

User  
id  
email  
passwordHash (if password auth is used)  
role  
status  
createdAt  
updatedAt

### CandidateProfile

CandidateProfile  
id  
userId  
experienceYears  
remotePreference  
relocationPreference  
salaryPreference  
employmentPreferences  
profileVersion  
createdAt  
updatedAt

### CandidateSkill

CandidateSkill  
id  
candidateProfileId  
canonicalSkill  
skillType  
source  
confidence  
createdAt

### JobSource

JobSource  
id  
name  
adapterType  
adapterVersion  
enabled  
accessPolicy  
schedule  
lastSuccessfulRunAt  
lastErrorAt  
healthStatus

### RawJob

RawJob  
id  
sourceId  
sourceJobIdentifier  
sourceUrl  
rawTitle  
rawCompany  
rawLocation  
rawDescription  
rawPublishedDateText  
rawSalaryText  
rawPayload/reference  
collectedAt

### Job

Job  
id  
sourceId  
rawJobId  
canonicalUrl  
title  
company  
description  
descriptionQuality  
locationText  
locationCategory  
publishedCalendar  
originalPublishedDateText  
publishedAt  
dateConfidence  
salaryType  
salaryMin  
salaryMax  
salaryCurrency  
salaryPeriod  
salaryEvidence  
salaryConfidence  
employmentType  
remoteStatus  
applicationMethod  
applyUrl  
applyEmail  
lifecycleStatus  
contentFingerprint  
createdAt  
updatedAt

### JobMatch

JobMatch  
id  
userId  
jobId  
score  
confidence  
roleScore  
skillScore  
experienceScore  
locationScore  
employmentScore  
freshnessScore  
salaryScore  
matchedEvidence  
missingEvidence  
uncertainEvidence  
explanation  
matcherVersion  
createdAt

### NotificationOutbox

NotificationOutbox  
id  
userId  
jobId  
notificationType  
payload  
status  
attemptCount  
nextAttemptAt  
lastError  
createdAt  
sentAt

## 5.3 Data Integrity

Use foreign keys, unique constraints, indexes, transactions, and explicit lifecycle states.

## 5.4 Provenance and Evidence

Raw source evidence, source-provided values, deterministic extraction, and AI-derived evidence must remain distinguishable. Important values retain evidence sufficient for debugging and reprocessing.

## 5.5 Ethiopian Market Data Rules

## Calendar

| **Value** | **Meaning**                          | **Authority**            |
|-----------|--------------------------------------|--------------------------|
| GREGORIAN | Gregorian date explicitly identified | Source/deterministic     |
| ETHIOPIAN | Ethiopian calendar identified        | Deterministic conversion |
| UNKNOWN   | Cannot establish calendar/date       | No guessing              |

## Salary

| **SalaryType** | **Example**              | **Canonical numeric value?** |
|----------------|--------------------------|------------------------------|
| EXACT          | 50,000 ETB/month         | Yes                          |
| RANGE          | 50,000–70,000 ETB/month  | Yes                          |
| STARTING_FROM  | Starting from 50,000 ETB | Minimum                      |
| UP_TO          | Up to 70,000 ETB         | Maximum                      |
| NEGOTIABLE     | Salary negotiable        | No                           |
| AS_PER_SCALE   | As per scale             | No                           |
| NOT_DISCLOSED  | Not disclosed            | No                           |
| UNKNOWN        | Could not determine      | No                           |

## Location

ADDIS_ABABA \| ETHIOPIA_CITY \| ETHIOPIA_REGION \| ETHIOPIA_REMOTE \| INTERNATIONAL_REMOTE \| INTERNATIONAL_ON_SITE \| HYBRID \| UNKNOWN

## Language

English is the MVP UI language. Amharic and Afaan Oromo source text may be preserved and processed as data where technically possible, but complete UI localization is outside v1.0.

## Local channels

Telegram and other channels may be integrated only when legitimate access is stable and maintainable. Popularity alone is not sufficient justification for an adapter.

## 5.6 Database Requirements

PostgreSQL is the canonical v1.0 database.

- Job(canonicalUrl)

- Job(contentFingerprint)

- Job(sourceId,lifecycleStatus)

- Job(publishedAt)

- JobMatch(userId,score)

- JobMatch(userId,jobId) UNIQUE

- NotificationOutbox(status,nextAttemptAt)

- SourceRun(sourceId,startedAt)

- CandidateSkill(candidateProfileId,canonicalSkill) UNIQUE

## 5.7 Migration Requirements

Schema changes must use versioned migrations. Destructive migrations require a verified backup.

# 6. Non-Functional Requirements

## 6.1 Performance

Heavy collection and AI must not execute in the API process. Scraping, parsing, and LLM work are worker responsibilities.

## 6.2 Reliability and Recovery

One source failure cannot stop other sources. Persistent worker work survives restart. Retries are bounded and observable, and permanent failures remain available for diagnosis.

## 6.3 Maintainability

Source-specific logic is isolated behind adapters. Matcher rules that change scores are versioned. AI schemas and prompts are versioned.

## 6.4 Scalability

The domain model permits later multi-user and queue expansion, but expansion follows measured bottlenecks.

## 6.5 Accessibility

Core workflows should be keyboard accessible, touch-friendly, semantically labeled, and not dependent on color alone.

## 6.6 Bandwidth Efficiency

Avoid unnecessary large assets and payloads and defer non-essential content.

## 6.7 Determinism

Identical structured input and matcherVersion must produce identical match output.

## 6.8 AI Independence

The full pipeline must operate with NoopProvider. AI failures must not stop the pipeline.

# 7. System Architecture and Operational Requirements

## 7.1 High-Level Architecture

Job Sources → Source Adapters → RawJob → Deterministic Normalization → Description / URL / Field Fidelity → Deterministic Extraction → AI Fallback (only when triggered) → Structured Evidence → Deduplication + Lifecycle → Deterministic Matcher → Match + Confidence + Explanation → Notification Outbox → Telegram → User Feedback → Precision Measurement

## 7.2 Process Separation

NestJS API and heavy background processing shall run as separate processes. API handles reads, profile changes, feedback, and operational commands. Worker handles collection, extraction, AI, matching, lifecycle, and notification dispatch.

## 7.3 Worker Responsibilities

- Source collection

- Health checks

- Normalization

- Extraction

- AI enrichment

- Deduplication

- Matching

- Lifecycle sweeps

- Notification dispatch

- Retries/recovery

- Backup orchestration where appropriate

## 7.4 API Responsibilities

- Job/match reads

- Profile updates

- Notification feedback

- Telegram linking

- Operational commands

- Source status reads

## 7.5 Durable Work and Locking

Long-running work shall have persistent state. Process death must not make an operation permanently invisible or impossible to retry.

Source collection requires source-level exclusivity. Task claiming shall be atomic, using row locks, SKIP LOCKED, advisory locks, or equivalent database-safe mechanisms.

## 7.6 Scheduling, Catch-Up, and Retry

If the worker misses a scheduled run because it was offline, the next startup must determine whether the missed operation should be executed.

Retries shall be bounded and observable. Permanent failures must be retained for diagnosis.

## 7.7 Ingestion Pipeline

## Adapter contract

interface JobSourceAdapter {  
collect(context): Promise\<RawJob\[\]\>;  
normalize(raw): Promise\<NormalizedJob\>;  
healthCheck(context): Promise\<HealthResult\>;  
}

## Collection sequence

1.  Acquire source content using a permitted mechanism.

2.  Apply source rate limits.

3.  Create SourceRun.

4.  Persist RawJob records.

5.  Normalize URLs and text.

6.  Extract structured content.

7.  Validate description/application target.

8.  Deduplicate.

9.  Persist Job.

10. Schedule enrichment/matching work.

11. Complete SourceRun with counts and errors.

## HTTP-first

HTTP/API/RSS/static parsing shall be attempted before browser automation. Playwright is a last resort for sources that genuinely require client-side rendering.

## Source ethics

The system shall not bypass authentication, CAPTCHA, access controls, anti-bot mechanisms, or source restrictions. Rate limits and source rules must be respected.

## Description quality

Descriptions shall be classified as sufficient, partial, or unusable using configurable deterministic checks.

## Application methods

ONLINE_URL \| EMAIL \| SOURCE_ACCOUNT \| PDF_FORM \| IN_PERSON \| INSTRUCTIONS \| UNKNOWN

A job must have a usable application path before notification unless the notification policy explicitly permits informational listings.

## 7.8 Observability and Drift Detection

## Source metrics

- Run count

- Success/failure

- Jobs discovered

- Jobs accepted

- Parse failures

- HTTP failures

- Duration

- Unexpected zero results

## Pipeline funnel

collected → parsed → valid → unique → active → matched → notified

## AI metrics

- calls

- bypassed

- success

- timeout

- invalid

- fallback

- duration

- provider/model

## Notification metrics

- queued

- sent

- failed

- retried

- rate-limited

- relevant

- not relevant

- unsure

## Drift detection

A source that suddenly produces zero jobs or sharply reduced extraction yield must produce an operator-visible warning.

# 8. Security and Privacy Requirements

## 8.1 Authentication

The seeded user shall be authenticated. Passwords, if used, shall use a modern password-hashing algorithm.

## 8.2 Authorization and Ownership

Ownership must be enforced server-side at the service layer.

## 8.3 Secrets Management

Database credentials, Telegram secrets, AI credentials, JWT/session secrets, and other sensitive configuration must be environment/secret-managed.

## 8.4 External AI Privacy

External providers are disabled by default. Enabling one requires explicit configuration and documented data handling.

## 8.5 Logging and Data Exposure

Logs must not contain passwords, tokens, Telegram secrets, or private candidate content.

## 8.6 Source Security

External source content is untrusted and must not be executed or treated as instructions.

## 8.7 AI Safety Boundaries

- No invented employer/salary/location/deadline/skill/application data.

- No silent overwrite of stronger source evidence.

- No notification solely because AI says a job is good.

- No external AI transmission of private candidate data without explicit configuration/consent.

- No hard dependency on AI for collection or core matching.

Job descriptions are untrusted data. Source text must never be treated as system instructions. Prompt boundaries must explicitly identify source content as data.

# 9. Testing and Verification Requirements

## 9.1 Unit Testing

- URL normalization

- Salary parsing

- Ethiopian calendar conversion

- Location classification

- Skill extraction

- Role extraction

- Deduplication

- Matcher calculations

- UNKNOWN behavior

- AI schema validation

- Notification eligibility

- Telegram retry/backoff

## 9.2 Integration Testing

Test Source → RawJob → Job → Match → Outbox → Telegram dispatch/feedback.

## 9.3 Real-Data Fixtures

Maintain representative fixtures for every source, including clean, malformed, duplicate, missing-field, Ethiopian-date, salary-ambiguous, and dead-link cases.

## 9.4 Determinism

Identical structured input and matcherVersion must produce identical match output.

## 9.5 Failure Testing

Simulate worker restart, AI timeout, invalid AI JSON, source timeout, zero-result source, Telegram 429, dead URL, and database contention.

## 9.6 Regression Expectations

Changes to source adapters, extraction logic, matcher rules, AI schemas/prompts, and notification eligibility shall preserve the associated fixtures and acceptance tests or update them deliberately with traceable version changes.

# 10. Validation and Acceptance Requirements

## 10.1 MVP KPIs

Notification Precision = Relevant delivered notifications / All delivered notifications

Relevant means the user marks the notification relevant or performs a defined high-intent action under the measurement policy.

- Notification volume

- Relevant rate

- Save rate

- Reject rate

- Apply rate

- Duplicate rate

- Dead-link rate

- Extraction success

- AI fallback rate

- AI failure rate

- Collection duration

## 10.2 Validation Period

Run the MVP for 14 days using real jobs.

## 10.3 Validation Question

When JobHunter sends an alert, is it worth the user's attention?

## 10.4 Threshold Policy

Do not invent an arbitrary precision target before collecting baseline data. Record precision from the first notification, establish the baseline, then set a formal target based on actual observed performance.

## 10.5 Acceptance Criteria

| **ID** | **Area**     | **Acceptance**                                                           |
|--------|--------------|--------------------------------------------------------------------------|
| AC-001 | Collection   | At least 3 real sources collect independently.                           |
| AC-002 | Isolation    | Failed source does not stop others.                                      |
| AC-003 | Traceability | Every accepted job traces to raw source evidence.                        |
| AC-004 | Application  | Every notified job has a usable application path.                        |
| AC-005 | Duplicates   | Known duplicate fixtures are handled correctly.                          |
| AC-006 | Dates        | Ethiopian dates convert deterministically; uncertain dates stay unknown. |
| AC-007 | Salary       | Negotiable/as-per-scale/unknown never become fabricated numbers.         |
| AC-008 | Location     | Missing location remains UNKNOWN.                                        |
| AC-009 | Matcher      | Same input/version produces same output.                                 |
| AC-010 | UNKNOWN      | Unknown does not automatically become negative evidence.                 |
| AC-011 | AI off       | Pipeline works with AI_PROVIDER=noop.                                    |
| AC-012 | AI failure   | Timeout/invalid output falls back safely.                                |
| AC-013 | Isolation    | Heavy work is outside API request handling.                              |
| AC-014 | Restart      | Pending work remains recoverable after worker restart.                   |
| AC-015 | Telegram     | Eligible notifications use persistent outbox.                            |
| AC-016 | Duplicates   | Equivalent notification event is not repeatedly delivered.               |
| AC-017 | Feedback     | User can classify delivered alerts.                                      |
| AC-018 | Health       | Unexpected zero-result runs are visible.                                 |
| AC-019 | Backup       | Backup can be restored.                                                  |
| AC-020 | Validation   | 14-day notification precision is measured.                               |

# 11. Implementation and Release Plan

## 11.1 Milestone 1 — Core Job Pipeline

- PostgreSQL

- Worker process

- Source abstraction

- 3–5 adapters

- RawJob

- Normalization

- URL validation

- Description quality

- Deduplication

- SourceRun

- Health checks

Exit condition: trustworthy jobs exist in PostgreSQL.

## 11.2 Milestone 2 — Deterministic Matching

- Seeded candidate

- Skills

- Roles

- Locations

- Remote preference

- Matcher

- Score

- Confidence

- UNKNOWN handling

- Evidence

Exit condition: real jobs receive explainable deterministic matches.

## 11.3 Milestone 3 — Telegram Loop

- Telegram linking

- Eligibility

- Outbox

- Delivery

- View

- Save

- Reject

- Apply/Open

- Feedback

Exit condition: useful alerts arrive reliably.

## 11.4 Milestone 4 — AI Fallback

- AiProvider

- NoopProvider

- OllamaProvider

- Strict schemas

- Triggers

- AI evidence

- Timeouts

- Fallback

Exit condition: AI improves ambiguous cases without becoming required.

## 11.5 Milestone 5 — Reliability and Validation

- Lifecycle sweeps

- Link-rot checks

- Backup

- Restore

- Operational metrics

- 14-day validation

Exit condition: real-world MVP validation is complete.

# 12. Post-MVP Roadmap

| **Phase** | **Addition**            | **Justification**                                                   |
|-----------|-------------------------|---------------------------------------------------------------------|
| 2         | Redis/BullMQ            | PostgreSQL work coordination becomes a measured bottleneck.         |
| 2         | Multi-user              | Personal validation proves repeated value.                          |
| 2         | CV parsing              | Manual profile setup becomes a bottleneck.                          |
| 2         | Application tracking    | Notification-only workflow becomes insufficient.                    |
| 2         | Saved-search automation | Users demonstrate need for automated queries.                       |
| 3         | pgvector                | Deterministic matching shows measured semantic limitations.         |
| 3         | Learned ranking         | Enough behavioral feedback exists.                                  |
| 3         | External AI             | Local quality/performance is insufficient and privacy is addressed. |
| 3         | Email/PWA/mobile        | Observed usage justifies additional channels.                       |

# 13. Risks and Mitigations

| **Risk**              | **Impact** | **Mitigation**                                                 |
|-----------------------|------------|----------------------------------------------------------------|
| Source layout changes | High       | Adapter isolation, fixtures, health/drift alerts.              |
| Expired/dead jobs     | High       | URL checks and lifecycle sweeps.                               |
| Poor extraction       | High       | Raw evidence, deterministic parsing, confidence, selective AI. |
| AI hallucination      | High       | Advisory AI, strict schema, provenance, capped evidence.       |
| CPU-heavy local AI    | Medium     | On-demand calls, worker isolation, per-run cap.                |
| Telegram rate limits  | Medium     | Outbox and retry/backoff.                                      |
| Worker/power restart  | Medium     | Persistent task state and catch-up.                            |
| Source proliferation  | High       | 3–5 source MVP limit.                                          |
| Overengineering       | High       | Validation gate before expansion.                              |
| Privacy leakage       | High       | Ownership checks and explicit external-AI consent.             |
| Backup failure        | High       | Off-machine backup plus restore test.                          |

# 14. Engineering Rules

These rules are binding on all implementation work. Each rule traces to the requirement it protects. Rules added in v1.1 are derived from existing principles and the implementation decisions recorded in Appendix E.

## 14.1 Data Integrity and Evidence

These rules protect the data-quality-first principle. A rule is violated if any code path can produce the prohibited outcome.

| **ID**  | **Rule**                                                                                                                                                                                                                                                         | **Traces to**            |
|---------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------|
| ENG-001 | No fabrication. A field value is produced only from source text or from a documented deterministic rule applied to source text. When evidence is insufficient the value is UNKNOWN; UNKNOWN is a valid state and is never silently treated as negative evidence. | AC-007, AC-008, AC-010   |
| ENG-002 | Raw source evidence is preserved. Every accepted Job traces to a RawJob, and a RawJob is never deleted or mutated by downstream stages.                                                                                                                          | FR-004, AC-003           |
| ENG-003 | Provenance stays distinguishable. Source-provided, deterministic, and AI-derived values are recorded as such for every important field.                                                                                                                          | FR-011, §5.4             |
| ENG-004 | Parsers and classifiers are total functions. They never throw on malformed, empty, or hostile input; they return UNKNOWN with the evidence examined.                                                                                                             | §9.5                     |
| ENG-005 | Conflicting evidence is recorded as CONFLICTING and is not resolved by guessing or by silently preferring one source.                                                                                                                                            | Appendix A EvidenceState |
| ENG-006 | Monetary amounts are stored as exact decimals, never binary floating point.                                                                                                                                                                                      | §5.5                     |

## 14.2 AI Boundary

| **ID**  | **Rule**                                                                                                                                                     | **Traces to** |
|---------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------|
| ENG-007 | AI is advisory. It produces evidence with confidence and never authoritative facts, final match decisions, or sole grounds for a notification.               | §2.3, §8.7    |
| ENG-008 | The full pipeline runs with AI_PROVIDER=noop. No collection, normalization, matching, or notification path may depend on AI availability.                    | AC-011, §6.8  |
| ENG-009 | AI output is parsed and schema-validated before use. Invalid output becomes a typed AI failure and falls back safely.                                        | AC-012, §4.7  |
| ENG-010 | Job descriptions and all source content are untrusted data. They are never executed and never treated as instructions; prompts explicitly mark them as data. | §8.6, §8.7    |
| ENG-011 | External AI providers are disabled by default and receive no private candidate data without explicit configuration and consent.                              | §8.4          |

## 14.3 Determinism and Versioning

| **ID**  | **Rule**                                                                                                                                                                                                                | **Traces to** |
|---------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------|
| ENG-012 | Identical structured input and matcherVersion produce identical output. Matcher and normalizer code takes time and randomness as injected inputs and never reads the system clock or a random source directly.          | AC-009, §6.7  |
| ENG-013 | Any change to weights, thresholds, or scoring logic requires a new matcherVersion. AI schemas, prompts, and date/salary conversion methods are versioned (for example ETHIOPIAN_CALENDAR_V1).                           | §4.6, §6.3    |
| ENG-014 | Changes to adapters, extraction, matcher rules, AI schemas or prompts, and notification eligibility preserve the associated fixtures and acceptance tests, or update them deliberately with a traceable version change. | §9.6          |

## 14.4 Architecture and Boundaries

| **ID**  | **Rule**                                                                                                                                                                                                                                                                                                                                                  | **Traces to** |
|---------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------|
| ENG-015 | Code is organized in layers: domain, application, ports, adapters, infrastructure. Dependencies point inward only: domain depends on nothing; application depends on domain and ports; only adapters and infrastructure depend on external libraries. The direction is enforced by an automated check in continuous integration, not by convention alone. | §6.3          |
| ENG-016 | Source-specific logic lives only inside source adapters. Shared deterministic logic (URL, salary, date, location, fingerprint) lives in the domain and is reused by every adapter.                                                                                                                                                                        | §3.5, FR-001  |
| ENG-017 | The API and worker are separate processes. Collection, parsing, AI, matching, lifecycle, and dispatch never run inside an API request.                                                                                                                                                                                                                    | AC-013, §7.2  |
| ENG-018 | No infrastructure is added without a measured bottleneck. Redis/BullMQ, vector search, and similar components stay deferred until the Post-MVP Roadmap conditions are met.                                                                                                                                                                                | §2.7, §12     |
| ENG-019 | Source ethics. HTTP, API, RSS, or static parsing is attempted before browser automation. Authentication, CAPTCHA, access controls, anti-bot mechanisms, and source restrictions are never bypassed, and each source is approved by the product owner, with its access policy recorded, before an adapter is written.                                      | §3.5, §7.7    |

## 14.5 Persistence, Queue, and Time

| **ID**  | **Rule**                                                                                                                                                                                                                                                                                                                                   | **Traces to**        |
|---------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------|
| ENG-020 | Schema changes use versioned migrations. Destructive migrations require a verified backup. Migrations must apply cleanly to an empty database.                                                                                                                                                                                             | §5.7, AC-019         |
| ENG-021 | Invariants are enforced in the database (foreign keys, unique and partial unique indexes), not only in application code. Hand-written SQL objects that the ORM cannot express must be guarded by a test or CI check so schema diffing cannot silently drop them.                                                                           | §3.7, §5.3           |
| ENG-022 | Database timestamps are produced and compared on the database clock in UTC. Behavior must not depend on a session timezone. New timestamp columns use a timezone-aware type.                                                                                                                                                               | §7.5                 |
| ENG-023 | Work is claimed atomically in a single statement using row locking with SKIP LOCKED. Each claim issues a fresh lease token. Heartbeat, completion, and failure are valid only for the current lease token and RUNNING status, so a stale owner can never alter a newer attempt.                                                            | AC-014, §7.5         |
| ENG-024 | A task attempt is counted when it is claimed, so a crash mid-attempt consumes an attempt and a poison task cannot loop forever. A clean shutdown may release a task and return the attempt.                                                                                                                                                | §6.2, §7.6           |
| ENG-025 | Expired leases are reaped on worker startup and on an interval. Stale RUNNING source runs are failed with reason LEASE_EXPIRED so the one-active-run-per-source constraint cannot wedge a source after a crash.                                                                                                                            | AC-014, §7.5         |
| ENG-026 | Permanent failures are retained for diagnosis. FAILED means a non-retryable error; DEAD_LETTER means retryable but exhausted. Both are terminal and both are visible in operator metrics.                                                                                                                                                  | §6.2                 |
| ENG-027 | The match and its notification outbox row are written in one transaction. Delivery is at-least-once; the outbox row has a unique event key per user, job, notification type, and event so an equivalent event is never inserted twice. A crash between sending and recording SENT may produce one duplicate and is documented as accepted. | AC-015, AC-016, §3.2 |

## 14.6 Numeric Units

| **ID**  | **Rule**                                                                                                                                                                                                                                                 | **Traces to** |
|---------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------|
| ENG-028 | Extraction confidence (salary, date, location, AI evidence) is a Probability in \[0,1\]. Match score and match confidence are a Percent in \[0,100\]. They are distinct types, validated at construction, and converted only through explicit functions. | Appendix B    |

## 14.7 Testing, Verification, and Change Control

| **ID**  | **Rule**                                                                                                                                                                                | **Traces to**    |
|---------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------|
| ENG-029 | Every normalizer and classifier has unit tests that include malformed and hostile input.                                                                                                | §9.1             |
| ENG-030 | Queue, outbox, index, and locking behavior is tested against a real PostgreSQL instance, not mocks, with isolated state between tests.                                                  | §9.2             |
| ENG-031 | Failure tests cover worker restart (including abrupt process kill), AI timeout, invalid AI output, source timeout, zero-result source, Telegram 429, dead URL, and database contention. | §9.5, AC-014     |
| ENG-032 | Secrets are supplied through environment configuration, validated at startup, never committed, and never logged. A committed example file documents required variables.                 | §8.3, §8.5       |
| ENG-033 | Each change is small and single-purpose. Verification evidence (type check, tests, migration applied from scratch) is reported before the change is merged.                             | Appendix C       |
| ENG-034 | Amending this SRS requires a version increment and a Document Control entry.                                                                                                            | Document Control |

# Appendix A. Core Enums

## Lifecycle

ACTIVE \| EXPIRED \| REMOVED \| NOT_FOUND

## Calendar

GREGORIAN \| ETHIOPIAN \| UNKNOWN

## SalaryType

EXACT \| RANGE \| STARTING_FROM \| UP_TO \| NEGOTIABLE \| NOT_DISCLOSED \| AS_PER_SCALE \| UNKNOWN

## LocationCategory

ADDIS_ABABA \| ETHIOPIA_CITY \| ETHIOPIA_REGION \| ETHIOPIA_REMOTE \| INTERNATIONAL_REMOTE \| INTERNATIONAL_ON_SITE \| HYBRID \| UNKNOWN

## EvidenceState

KNOWN \| UNKNOWN \| CONFLICTING

## SkillEvidence

EXACT_MATCH \| CANONICAL_ALIAS \| RELATED_SKILL \| TRANSFERABLE \| AI_SUGGESTED \| UNKNOWN

## AIStatus

SUCCESS \| TIMEOUT \| UNAVAILABLE \| INVALID_OUTPUT \| SCHEMA_ERROR \| PROVIDER_ERROR \| FALLBACK

## NotificationStatus

PENDING \| PROCESSING \| SENT \| FAILED \| CANCELLED

## WorkTaskStatus

PENDING \| RUNNING \| SUCCEEDED \| FAILED \| DEAD_LETTER

## DescriptionQuality

SUFFICIENT \| PARTIAL \| UNUSABLE

## SalaryPeriod

HOUR \| DAY \| WEEK \| MONTH \| YEAR \| UNKNOWN

## ProvenanceSource

SOURCE \| DETERMINISTIC \| AI

# Appendix B. Example Data Objects

## B.1 Salary

{  
"salaryType": "RANGE",  
"salaryMin": 50000,  
"salaryMax": 70000,  
"salaryCurrency": "ETB",  
"salaryPeriod": "MONTH",  
"salaryEvidence": "50,000–70,000 ETB per month",  
"salaryConfidence": 0.94  
}

## B.2 Ethiopian date

{  
"originalPublishedDateText": "መስከረም 5, 2018",  
"publishedCalendar": "ETHIOPIAN",  
"publishedAt": "deterministically converted Gregorian date",  
"dateConfidence": 0.99,  
"conversionMethod": "ETHIOPIAN_CALENDAR_V1"  
}

## B.3 Match

{  
"score": 84,  
"confidence": 91,  
"roleScore": 92,  
"skillScore": 86,  
"experienceScore": 80,  
"locationScore": 100,  
"employmentScore": 100,  
"freshnessScore": 90,  
"salaryScore": null,  
"matchedSkills": \["TypeScript", "React", "Node.js"\],  
"missingSkills": \["Kubernetes"\],  
"uncertainSkills": \["AWS"\],  
"matcherVersion": "1.0.0"  
}

## B.4 AI evidence

{  
"provider": "ollama",  
"model": "configured-model",  
"schemaVersion": "job-extraction-1",  
"promptVersion": "job-extraction-prompt-1",  
"field": "remoteStatus",  
"value": "HYBRID",  
"confidence": 0.88,  
"evidence": "Hybrid work available after probation",  
"status": "SUCCESS"  
}

# Appendix C. Definition of Done

- Clean database migration succeeds.

- At least 3 real sources operate.

- Raw source evidence is inspectable.

- Normalization and deduplication have tests.

- Ethiopian date and salary fixtures pass.

- Matcher is deterministic and versioned.

- UNKNOWN behavior is tested.

- AI can be disabled.

- AI failures do not stop the pipeline.

- API and Worker are separate processes.

- Worker work is persistent/recoverable.

- Telegram uses an outbox.

- Feedback is recorded.

- Source health catches unexpected zero-result runs.

- Backup restore is tested.

- 14-day real-world validation is completed.

- Notification Precision is measured and documented.

# Appendix D. Final Product Definition

JobHunter v1.0 is successful when it can reliably turn fragmented job postings into a small stream of trustworthy opportunities.

SOURCE  
↓  
RAW DATA  
↓  
NORMALIZE  
↓  
VERIFY  
↓  
STRUCTURE  
↓  
AI ONLY WHEN NEEDED  
↓  
MATCH DETERMINISTICALLY  
↓  
CONFIDENCE  
↓  
FILTER  
↓  
TELEGRAM  
↓  
USER FEEDBACK  
↓  
NOTIFICATION PRECISION

The first objective is not to build a large job platform. It is to prove that the user can trust JobHunter's alerts. Once that is demonstrated, multi-user support, queues, semantic matching, advanced AI, application tracking, and learned ranking can be added as evidence-driven expansions.

# Appendix E. Implementation Clarifications (v1.1)

These clarifications resolve ambiguities found during implementation. They refine, and do not replace, the requirements in Sections 1 to 13 and Appendices A to D.

| **Topic**                  | **Clarification**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Confidence scales          | Extraction confidence uses 0..1 (Appendix B.1, B.2, B.4). Match score and confidence use 0..100 (Appendix B.3). See ENG-028.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Description quality        | descriptionQuality is required on every Job and takes SUFFICIENT, PARTIAL, or UNUSABLE; it has no UNKNOWN value because classification occurs before the Job is persisted (§7.7). A Job classified UNUSABLE is persisted for traceability and funnel metrics but is excluded from matching and notification.                                                                                                                                                                                                                                                                                                                                                                                                |
| Calendar detection         | The calendar is ETHIOPIAN only on explicit signals: an Ethiopian month name, an era marker such as E.C. or ዓ.ም, or a calendar declared in the source adapter configuration. It is GREGORIAN only on explicit signals or a declared source calendar. Numeric-only dates without such a signal are UNKNOWN with publishedAt null. Invalid dates (for example Pagume 7, or Pagume 6 in a non-leap year) are UNKNOWN. Ethiopian leap years are those where year mod 4 equals 3. Reference anchors: Meskerem 1, 2018 E.C. is 2025-09-11; Meskerem 5, 2018 E.C. (Appendix B.2) is 2025-09-15. Relative dates are resolved against collectedAt with reduced confidence and are not mixed with calendar conversion. |
| Salary currency and period | salaryPeriod takes HOUR, DAY, WEEK, MONTH, YEAR, or UNKNOWN. Neither currency nor period is defaulted: absent a hint, period is UNKNOWN, and currency is set only from a recognized token or a currency declared in the source adapter configuration. The parser does not convert across periods or currencies. Numbers are extracted only when adjacent to a currency token or salary keyword. If min exceeds max the salary is UNKNOWN (conflicting). NEGOTIABLE, AS_PER_SCALE, NOT_DISCLOSED, and UNKNOWN carry no numeric values and no currency.                                                                                                                                                       |
| Location classification    | Classification uses the source location field. Precedence: HYBRID; remote with an Ethiopian place gives ETHIOPIA_REMOTE; remote with a non-Ethiopian place gives INTERNATIONAL_REMOTE; remote with no geography gives locationCategory UNKNOWN with remoteStatus REMOTE; Addis Ababa alone gives ADDIS_ABABA; other Ethiopian cities give ETHIOPIA_CITY and regions give ETHIOPIA_REGION; a non-Ethiopian place gives INTERNATIONAL_ON_SITE; conflicting signals or no recognizable place give UNKNOWN. The place gazetteer is data, not code branches.                                                                                                                                                     |
| Work task model            | The durable work table (WorkTask) stores type, payload, optional dedupeKey, status, priority, attempts, maxAttempts, runAfter, lockedAt, lockedBy, leaseExpiresAt, leaseToken, optional sourceRunId, startedAt, finishedAt, lastError, and lastErrorAt. dedupeKey is unique only among active tasks (PENDING or RUNNING) so a completed task can be enqueued again. Retryable failures return to PENDING with bounded exponential backoff.                                                                                                                                                                                                                                                                  |
| Notification event key     | A notification event is identified by user, job, notificationType, and eventKey. The first alert uses NEW_MATCH. A supported material change (salary, deadline, application path) uses MATERIAL_CHANGE plus a hash of the changed fields. Telegram 429 responses honor the retry_after value.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Source enablement          | `enabled` governs all collection, scheduled and manual; a disabled source is never collected, and a manual run of one returns `409 SOURCE_DISABLED`. Approval is not a stored flag: per the Source approval record, an unapproved source has no adapter, and a collection for one fails permanently with an explicit "no adapter" error.                                                                                                                                                                                                                                                                                                                                                                              |
| Source approval record     | For each source the product owner records approval, the access mechanism (feed, API, static HTML), the robots and terms review outcome, the stable job identifier field, and the declared calendar and currency if any. A source without a recorded approval has no adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                |
