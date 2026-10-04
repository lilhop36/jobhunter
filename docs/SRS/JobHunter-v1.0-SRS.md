JOBHUNTER v1.0
Software Requirements Specification
Industry-Standard Structured Edition
Pragmatic MVP â€” Ethiopia-first, single-user, data-quality-first
job discovery and notification system
Document Control
Document basis: This edition restructures the uploaded JobHunter v1.0 Full SRS. Product scope, decisions, requirements, constraints, and acceptance criteria are retained; the principal change is organization into a conventional SRS hierarchy.
Table of Contents
1. Introduction
  1.1 Purpose
  1.2 Scope
  1.3 Product Definition
  1.4 Problem Statement
  1.5 Product Vision
  1.6 Goals
  1.7 Non-Goals
  1.8 Definitions and Acronyms
  1.9 Reference Basis
2. Overall Description
  2.1 Product Perspective
  2.2 Users and Operating Model
  2.3 Product Principles
  2.4 System Scope and Boundaries
  2.5 Operating Environment
  2.6 Assumptions and Constraints
  2.7 Deferred Infrastructure
3. External Interface Requirements
  3.1 User Interface
  3.2 Telegram Interface
  3.3 Web Application Interface
  3.4 REST API Interface
  3.5 Job Source Interfaces
  3.6 AI Provider Interface
  3.7 Database and Persistence Interface
4. System Features and Functional Requirements
  4.1 Functional Requirements Overview
  4.2 Source Management and Collection
  4.3 Data Fidelity, Normalization, and Validation
  4.4 Deduplication and Job Lifecycle
  4.5 Candidate Profile and Preferences
  4.6 Deterministic Matching
  4.7 AI-Assisted Extraction
  4.8 Notification and Feedback
  4.9 Health, Backup, and Recovery
5. Data Requirements
  5.1 Domain Entities
  5.2 Entity Attributes
  5.3 Data Integrity
  5.4 Provenance and Evidence
  5.5 Ethiopian Market Data Rules
  5.6 Database Requirements
  5.7 Migration Requirements
6. Non-Functional Requirements
  6.1 Performance
  6.2 Reliability and Recovery
  6.3 Maintainability
  6.4 Scalability
  6.5 Accessibility
  6.6 Bandwidth Efficiency
  6.7 Determinism
  6.8 AI Independence
7. System Architecture and Operational Requirements
  7.1 High-Level Architecture
  7.2 Process Separation
  7.3 Worker Responsibilities
  7.4 API Responsibilities
  7.5 Durable Work and Locking
  7.6 Scheduling, Catch-Up, and Retry
  7.7 Ingestion Pipeline
  7.8 Observability and Drift Detection
8. Security and Privacy Requirements
  8.1 Authentication
  8.2 Authorization and Ownership
  8.3 Secrets Management
  8.4 External AI Privacy
  8.5 Logging and Data Exposure
  8.6 Source Security
  8.7 AI Safety Boundaries
9. Testing and Verification Requirements
  9.1 Unit Testing
  9.2 Integration Testing
  9.3 Real-Data Fixtures
  9.4 Determinism
  9.5 Failure Testing
  9.6 Regression Expectations
10. Validation and Acceptance Requirements
  10.1 MVP KPIs
  10.2 Validation Period
  10.3 Validation Question
  10.4 Threshold Policy
  10.5 Acceptance Criteria
11. Implementation and Release Plan
  11.1 Milestone 1 â€” Core Job Pipeline
  11.2 Milestone 2 â€” Deterministic Matching
  11.3 Milestone 3 â€” Telegram Loop
  11.4 Milestone 4 â€” AI Fallback
  11.5 Milestone 5 â€” Reliability and Validation
12. Post-MVP Roadmap
13. Risks and Mitigations
14. Engineering Rules
Appendix A. Core Enums
Appendix B. Example Data Objects
Appendix C. Definition of Done
1. Introduction
1.1 Purpose
This SRS defines the requirements for JobHunter v1.0, a single-user, Ethiopia-first job discovery and notification system. It serves as the authoritative implementation specification for the MVP.
1.2 Scope
The MVP continuously collects jobs from a deliberately small set of reliable and permitted sources, preserves raw evidence, normalizes and validates listings, removes duplicates and unusable opportunities, extracts structured fields deterministically, optionally uses AI for ambiguous cases, compares jobs against one candidate profile, and delivers high-confidence opportunities through Telegram.
1.3 Product Definition
JobHunter v1.0 is a single-user, Ethiopia-first job discovery and filtering system built around a trustworthy job-data pipeline, deterministic matching, and optional AI-assisted extraction.
Collect â†’ Clean â†’ Verify â†’ Structure â†’ Match â†’ Explain â†’ Notify â†’ Measure
1.4 Problem Statement
Job opportunities are fragmented across job boards, company pages, permitted public channels, PDFs, and other sources. Listings may be duplicated, expired, poorly structured, missing salary information, ambiguous about location, or difficult to compare with a candidate profile. Manually checking these sources consumes time and attention.
1.5 Product Vision
JobHunter should behave like a disciplined personal job-search assistant: discover opportunities broadly enough to be useful, filter aggressively enough to reduce noise, and explain every delivered match using evidence.
1.6 Goals
Collect from 3â€“5 actively maintained sources.
Preserve raw source evidence.
Normalize URLs, text, dates, salary, location, title, and company.
Detect duplicate jobs.
Detect unusable/dead application targets.
Support Ethiopian and Gregorian dates without guessing.
Represent local salary states such as NEGOTIABLE and AS_PER_SCALE.
Match jobs deterministically against one candidate profile.
Separate compatibility score from confidence.
Explain matched, missing, and uncertain evidence.
Use AI only when deterministic extraction is insufficient.
Deliver actionable Telegram notifications.
Measure notification usefulness over real-world use.
1.7 Non-Goals
Public multi-user SaaS in v1.0.
Large-scale source coverage.
AI-generated job facts.
AI as authoritative matcher.
pgvector/vector ranking.
Redis/BullMQ.
Automatic CV parsing.
Cover-letter generation.
Full application lifecycle.
Email channel.
Social login.
Mobile application.
Paid AI dependency.
1.8 Definitions and Acronyms
1.9 Reference Basis
Primary source: uploaded â€œJobHunter v1.0 â€” Full SRSâ€, Version 1.0, dated 2026-10-04. No additional external product requirements are introduced by this restructuring.
2. Overall Description
2.1 Product Perspective
The system is a personal job-search pipeline with source adapters, a persistent PostgreSQL coordination/data layer, a separate worker process for heavy background work, a web interface for inspection and profile management, Telegram for notifications, and optional AI providers for ambiguous extraction cases.
The primary processing flow is:
Job Sources â†’ Source Adapters â†’ RawJob â†’ Deterministic Normalization â†’ Field Fidelity â†’ Deterministic Extraction â†’ AI Fallback (only when triggered) â†’ Structured Evidence â†’ Deduplication + Lifecycle â†’ Deterministic Matcher â†’ Match + Confidence + Explanation â†’ Notification Outbox â†’ Telegram â†’ User Feedback â†’ Precision Measurement
2.2 Users and Operating Model
Primary user
One seeded candidate owns one profile and one Telegram destination.
Multi-user readiness
Ownership fields such as userId shall remain in the schema where useful. Registration, invitation, multi-user administration, dormant-user processing, and multi-user notification policies are deferred.
Operator
The developer/operator may inspect source health, worker runs, errors, and system configuration. This does not require a large customer-facing admin dashboard.
2.3 Product Principles
Data quality first â€” bad structured data produces bad matches.
Deterministic first â€” clear information is handled by reproducible rules.
AI is advisory â€” it produces evidence, not authoritative facts or final decisions.
Unknown is valid â€” unknown information must not be silently treated as negative evidence.
Evidence before claims â€” important values retain provenance.
Score is not confidence â€” compatibility and evidence completeness are different dimensions.
Graceful degradation â€” AI, a source, or Telegram can fail without destroying the pipeline.
Attention is the product â€” useful alerts matter more than alert volume.
Scope follows validation â€” infrastructure and features are justified by measured bottlenecks.
2.4 System Scope and Boundaries
The v1.0 boundary is intentionally narrow: one seeded candidate, one Telegram destination, a small set of actively maintained sources, PostgreSQL-backed durable work, and a deterministic matching/notification loop. Broader platform capabilities are deferred until validation demonstrates a need.
2.5 Operating Environment
Primary user: one seeded candidate.
Primary channel: Telegram.
Persistent database: PostgreSQL.
Backend API: NestJS.
Background processing: separate Node.js worker process.
AI: optional, on-demand, advisory; local Ollama or optional external HTTP provider.
Client interface: web application.
Geographic priority: Ethiopia â†’ Remote â†’ International.
2.6 Assumptions and Constraints
The MVP is intentionally single-user.
Only a deliberately small set of actively maintained sources is targeted.
Core usefulness must not depend on AI availability.
The system must respect source access policies and must not bypass authentication, CAPTCHA, access controls, anti-bot mechanisms, or source restrictions.
The source SRS defers Redis/BullMQ, pgvector/vector ranking, automatic CV parsing, cover-letter generation, full application lifecycle, email, social login, mobile application, and paid AI dependency.
2.7 Deferred Infrastructure
Redis/BullMQ is not required in v1.0. A PostgreSQL-backed work model is sufficient for the single-user MVP. Later queue infrastructure must preserve domain semantics.
3. External Interface Requirements
3.1 User Interface
Required routes
/dashboard
/jobs
/jobs/:id
/matches
/profile
/settings
/settings/telegram
Dashboard
The dashboard prioritizes new matches, high-confidence opportunities, notification status, and basic source health.
Match detail
Show score, confidence, factor breakdown, matched skills, missing skills, uncertain fields, source, salary, location, description quality, and application path.
Provenance
Source-provided, deterministic, and AI-derived fields must remain distinguishable.
Low bandwidth
Avoid unnecessary large assets and payloads. Defer non-essential content.
Accessibility
Core workflows should be keyboard accessible, touch-friendly, semantically labeled, and not dependent on color alone.
3.2 Telegram Interface
Linking
Telegram shall be linked using a secure short-lived deep-link token. The token must not encode private profile data.
Eligibility
ACTIVE
AND usable application target
AND not already notified for equivalent event
AND score >= threshold
AND confidence >= threshold
AND not suppressed/rejected
Content
Job title
Company
Location
Score
Confidence
Why it matches
Matched skills
Missing/uncertain evidence
Salary when known
Application action
Source
Actions
VIEW | SAVE | REJECT | APPLY / OPEN / COPY EMAIL
Rate limits
Telegram failures and 429 responses shall be handled by persistent outbox retry/backoff. Notification failure must not delete the underlying match.
Duplicate notification
The same qualifying job event shall not be delivered repeatedly unless an explicitly supported material-change event occurs.
3.3 Web Application Interface
The web application exposes the required routes, dashboard, match detail, provenance, low-bandwidth behavior, and accessibility behaviors specified in the source SRS.
3.4 REST API Interface
Core endpoints
Manual run
If a source is already active, the API returns conflict rather than creating concurrent work.
Error format
{
  "error": {
    "code": "SOURCE_RUN_ACTIVE",
    "message": "Source collection is already running"
  }
}
3.5 Job Source Interfaces
interface JobSourceAdapter {
  collect(context): Promise<RawJob[]>;
  normalize(raw): Promise<NormalizedJob>;
  healthCheck(context): Promise<HealthResult>;
}
HTTP/API/RSS/static parsing shall be attempted before browser automation. Playwright is a last resort for sources that genuinely require client-side rendering.
The system shall not bypass authentication, CAPTCHA, access controls, anti-bot mechanisms, or source restrictions. Rate limits and source rules must be respected.
Descriptions shall be classified as sufficient, partial, or unusable using configurable deterministic checks.
ONLINE_URL | EMAIL | SOURCE_ACCOUNT | PDF_FORM | IN_PERSON | INSTRUCTIONS | UNKNOWN
A job must have a usable application path before notification unless the notification policy explicitly permits informational listings.
3.6 AI Provider Interface
AiProvider
â”œâ”€â”€ OllamaProvider
â”œâ”€â”€ ExternalHttpProvider (optional)
â””â”€â”€ NoopProvider
Ambiguous skill extraction
Low-confidence role interpretation
Ambiguous seniority
Ambiguous remote/location wording
Difficult structured extraction
Evidence-backed explanation generation from existing facts
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
3.7 Database and Persistence Interface
Canonical database
PostgreSQL is the canonical v1.0 database.
Integrity
Use foreign keys, unique constraints, indexes, transactions, and explicit lifecycle states.
Recommended indexes
Job(canonicalUrl)
Job(contentFingerprint)
Job(sourceId,lifecycleStatus)
Job(publishedAt)
JobMatch(userId,score)
JobMatch(userId,jobId) UNIQUE
NotificationOutbox(status,nextAttemptAt)
SourceRun(sourceId,startedAt)
CandidateSkill(candidateProfileId,canonicalSkill) UNIQUE
Migrations
Schema changes must use versioned migrations. Destructive migrations require a verified backup.
4. System Features and Functional Requirements
4.1 Functional Requirements Overview
The following FR identifiers and wording are the authoritative functional baseline carried forward from the source SRS.
4.2 Source Management and Collection
Enabled sources shall be represented with adapter type/version, schedule, access policy, and health. Enabled sources shall be collected on schedule, and a source failure must not stop other sources.
4.3 Data Fidelity, Normalization, and Validation
Collected jobs shall preserve raw evidence, be normalized before matching, have application targets normalized and verified, and have description quality classified using configurable deterministic checks. Important fields retain provenance.
4.4 Deduplication and Job Lifecycle
The system shall detect duplicates using multiple signals and detect expired, removed, and dead jobs. A job must have a usable application path before notification unless notification policy explicitly permits informational listings.
4.5 Candidate Profile and Preferences
The system shall maintain one candidate matching profile. The source model includes candidate skills, target roles, location preferences, experience, remote preference, relocation preference, salary preference, employment preferences, and profile version.
4.6 Deterministic Matching
Initial weights
Weights are a versioned initial hypothesis. They must be evaluated against real notifications.
Skill credit
UNKNOWN rule
UNKNOWN is not automatically a failure. A factor with unknown evidence may be excluded from the denominator and the known weights renormalized. Confidence/evidence completeness must decrease.
FinalScore = sum(known score Ã- weight) / sum(known weights)
Salary
Known salary may participate in salary preference scoring. Negotiable, as-per-scale, not-disclosed, and unknown salary shall normally be excluded from the salary denominator unless the candidate explicitly requires disclosed salary.
Remote
Remote preference shall positively affect remote opportunities when remote is preferred/required and reject or penalize onsite jobs only when onsite is excluded.
Confidence
Confidence measures evidence completeness and extraction certainty. It is not another relevance score.
Versioning
Every JobMatch stores matcherVersion. Changes to weights, thresholds, or scoring logic require a new version.
4.7 AI-Assisted Extraction
Providers
AiProvider
â”œâ”€â”€ OllamaProvider
â”œâ”€â”€ ExternalHttpProvider (optional)
â””â”€â”€ NoopProvider
v1.0 AI use cases
Ambiguous skill extraction
Low-confidence role interpretation
Ambiguous seniority
Ambiguous remote/location wording
Difficult structured extraction
Evidence-backed explanation generation from existing facts
Prohibitions
No invented employer/salary/location/deadline/skill/application data.
No silent overwrite of stronger source evidence.
No notification solely because AI says a job is good.
No external AI transmission of private candidate data without explicit configuration/consent.
No hard dependency on AI for collection or core matching.
Explicit triggers
Call AI only when one or more conditions apply:
- no skills detected despite substantial description;
- role confidence below configured threshold;
- remote/location wording ambiguous;
- seniority ambiguous;
- critical field remains UNKNOWN;
- recoverable description is difficult to structure.
Limits
AI_PROVIDER=noop|ollama|external
AI_ANALYSIS_TIMEOUT_MS=15000
AI_ANALYSIS_MAX_PER_RUN=50
Structured output
AI output shall be parsed and schema-validated before use. Invalid output becomes a typed AI failure.
Prompt injection
Job descriptions are untrusted data. Source text must never be treated as system instructions. Prompt boundaries must explicitly identify source content as data.
AI evidence
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
4.8 Notification and Feedback
The system shall notify only eligible active jobs, persist notification delivery state in an outbox, prevent repeated equivalent events, and record relevant/not relevant/unsure user feedback. Telegram failures and 429 responses shall trigger persistent retry/backoff without deleting the underlying match.
4.9 Health, Backup, and Recovery
The system shall detect abnormal source behavior, run scheduled database backups, recover persistent worker work after restart, and preserve notification/match state across transient Telegram failures.
5. Data Requirements
5.1 Domain Entities
User
CandidateProfile
CandidateSkill
TargetRole
LocationPreference
JobSource
SourceRun
RawJob
Job
JobSkill
AiAnalysisRequest
AiEvidence
JobMatch
NotificationOutbox
NotificationFeedback
SystemLog
BackupRun
5.2 Entity Attributes
User
User
id
email
passwordHash (if password auth is used)
role
status
createdAt
updatedAt
CandidateProfile
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
CandidateSkill
CandidateSkill
id
candidateProfileId
canonicalSkill
skillType
source
confidence
createdAt
JobSource
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
RawJob
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
Job
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
JobMatch
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
NotificationOutbox
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
5.3 Data Integrity
Use foreign keys, unique constraints, indexes, transactions, and explicit lifecycle states.
5.4 Provenance and Evidence
Raw source evidence, source-provided values, deterministic extraction, and AI-derived evidence must remain distinguishable. Important values retain evidence sufficient for debugging and reprocessing.
5.5 Ethiopian Market Data Rules
Calendar
Salary
Location
ADDIS_ABABA | ETHIOPIA_CITY | ETHIOPIA_REGION | ETHIOPIA_REMOTE | INTERNATIONAL_REMOTE | INTERNATIONAL_ON_SITE | HYBRID | UNKNOWN
Language
English is the MVP UI language. Amharic and Afaan Oromo source text may be preserved and processed as data where technically possible, but complete UI localization is outside v1.0.
Local channels
Telegram and other channels may be integrated only when legitimate access is stable and maintainable. Popularity alone is not sufficient justification for an adapter.
5.6 Database Requirements
PostgreSQL is the canonical v1.0 database.
Job(canonicalUrl)
Job(contentFingerprint)
Job(sourceId,lifecycleStatus)
Job(publishedAt)
JobMatch(userId,score)
JobMatch(userId,jobId) UNIQUE
NotificationOutbox(status,nextAttemptAt)
SourceRun(sourceId,startedAt)
CandidateSkill(candidateProfileId,canonicalSkill) UNIQUE
5.7 Migration Requirements
Schema changes must use versioned migrations. Destructive migrations require a verified backup.
6. Non-Functional Requirements
6.1 Performance
Heavy collection and AI must not execute in the API process. Scraping, parsing, and LLM work are worker responsibilities.
6.2 Reliability and Recovery
One source failure cannot stop other sources. Persistent worker work survives restart. Retries are bounded and observable, and permanent failures remain available for diagnosis.
6.3 Maintainability
Source-specific logic is isolated behind adapters. Matcher rules that change scores are versioned. AI schemas and prompts are versioned.
6.4 Scalability
The domain model permits later multi-user and queue expansion, but expansion follows measured bottlenecks.
6.5 Accessibility
Core workflows should be keyboard accessible, touch-friendly, semantically labeled, and not dependent on color alone.
6.6 Bandwidth Efficiency
Avoid unnecessary large assets and payloads and defer non-essential content.
6.7 Determinism
Identical structured input and matcherVersion must produce identical match output.
6.8 AI Independence
The full pipeline must operate with NoopProvider. AI failures must not stop the pipeline.
7. System Architecture and Operational Requirements
7.1 High-Level Architecture
Job Sources â†’ Source Adapters â†’ RawJob â†’ Deterministic Normalization â†’ Description / URL / Field Fidelity â†’ Deterministic Extraction â†’ AI Fallback (only when triggered) â†’ Structured Evidence â†’ Deduplication + Lifecycle â†’ Deterministic Matcher â†’ Match + Confidence + Explanation â†’ Notification Outbox â†’ Telegram â†’ User Feedback â†’ Precision Measurement
7.2 Process Separation
NestJS API and heavy background processing shall run as separate processes. API handles reads, profile changes, feedback, and operational commands. Worker handles collection, extraction, AI, matching, lifecycle, and notification dispatch.
7.3 Worker Responsibilities
Source collection
Health checks
Normalization
Extraction
AI enrichment
Deduplication
Matching
Lifecycle sweeps
Notification dispatch
Retries/recovery
Backup orchestration where appropriate
7.4 API Responsibilities
Job/match reads
Profile updates
Notification feedback
Telegram linking
Operational commands
Source status reads
7.5 Durable Work and Locking
Long-running work shall have persistent state. Process death must not make an operation permanently invisible or impossible to retry.
Source collection requires source-level exclusivity. Task claiming shall be atomic, using row locks, SKIP LOCKED, advisory locks, or equivalent database-safe mechanisms.
7.6 Scheduling, Catch-Up, and Retry
If the worker misses a scheduled run because it was offline, the next startup must determine whether the missed operation should be executed.
Retries shall be bounded and observable. Permanent failures must be retained for diagnosis.
7.7 Ingestion Pipeline
Adapter contract
interface JobSourceAdapter {
  collect(context): Promise<RawJob[]>;
  normalize(raw): Promise<NormalizedJob>;
  healthCheck(context): Promise<HealthResult>;
}
Collection sequence
Acquire source content using a permitted mechanism.
Apply source rate limits.
Create SourceRun.
Persist RawJob records.
Normalize URLs and text.
Extract structured content.
Validate description/application target.
Deduplicate.
Persist Job.
Schedule enrichment/matching work.
Complete SourceRun with counts and errors.
HTTP-first
HTTP/API/RSS/static parsing shall be attempted before browser automation. Playwright is a last resort for sources that genuinely require client-side rendering.
Source ethics
The system shall not bypass authentication, CAPTCHA, access controls, anti-bot mechanisms, or source restrictions. Rate limits and source rules must be respected.
Description quality
Descriptions shall be classified as sufficient, partial, or unusable using configurable deterministic checks.
Application methods
ONLINE_URL | EMAIL | SOURCE_ACCOUNT | PDF_FORM | IN_PERSON | INSTRUCTIONS | UNKNOWN
A job must have a usable application path before notification unless the notification policy explicitly permits informational listings.
7.8 Observability and Drift Detection
Source metrics
Run count
Success/failure
Jobs discovered
Jobs accepted
Parse failures
HTTP failures
Duration
Unexpected zero results
Pipeline funnel
collected â†’ parsed â†’ valid â†’ unique â†’ active â†’ matched â†’ notified
AI metrics
calls
bypassed
success
timeout
invalid
fallback
duration
provider/model
Notification metrics
queued
sent
failed
retried
rate-limited
relevant
not relevant
unsure
Drift detection
A source that suddenly produces zero jobs or sharply reduced extraction yield must produce an operator-visible warning.
8. Security and Privacy Requirements
8.1 Authentication
The seeded user shall be authenticated. Passwords, if used, shall use a modern password-hashing algorithm.
8.2 Authorization and Ownership
Ownership must be enforced server-side at the service layer.
8.3 Secrets Management
Database credentials, Telegram secrets, AI credentials, JWT/session secrets, and other sensitive configuration must be environment/secret-managed.
8.4 External AI Privacy
External providers are disabled by default. Enabling one requires explicit configuration and documented data handling.
8.5 Logging and Data Exposure
Logs must not contain passwords, tokens, Telegram secrets, or private candidate content.
8.6 Source Security
External source content is untrusted and must not be executed or treated as instructions.
8.7 AI Safety Boundaries
No invented employer/salary/location/deadline/skill/application data.
No silent overwrite of stronger source evidence.
No notification solely because AI says a job is good.
No external AI transmission of private candidate data without explicit configuration/consent.
No hard dependency on AI for collection or core matching.
Job descriptions are untrusted data. Source text must never be treated as system instructions. Prompt boundaries must explicitly identify source content as data.
9. Testing and Verification Requirements
9.1 Unit Testing
URL normalization
Salary parsing
Ethiopian calendar conversion
Location classification
Skill extraction
Role extraction
Deduplication
Matcher calculations
UNKNOWN behavior
AI schema validation
Notification eligibility
Telegram retry/backoff
9.2 Integration Testing
Test Source â†’ RawJob â†’ Job â†’ Match â†’ Outbox â†’ Telegram dispatch/feedback.
9.3 Real-Data Fixtures
Maintain representative fixtures for every source, including clean, malformed, duplicate, missing-field, Ethiopian-date, salary-ambiguous, and dead-link cases.
9.4 Determinism
Identical structured input and matcherVersion must produce identical match output.
9.5 Failure Testing
Simulate worker restart, AI timeout, invalid AI JSON, source timeout, zero-result source, Telegram 429, dead URL, and database contention.
9.6 Regression Expectations
Changes to source adapters, extraction logic, matcher rules, AI schemas/prompts, and notification eligibility shall preserve the associated fixtures and acceptance tests or update them deliberately with traceable version changes.
10. Validation and Acceptance Requirements
10.1 MVP KPIs
Notification Precision = Relevant delivered notifications / All delivered notifications
Relevant means the user marks the notification relevant or performs a defined high-intent action under the measurement policy.
Notification volume
Relevant rate
Save rate
Reject rate
Apply rate
Duplicate rate
Dead-link rate
Extraction success
AI fallback rate
AI failure rate
Collection duration
10.2 Validation Period
Run the MVP for 14 days using real jobs.
10.3 Validation Question
When JobHunter sends an alert, is it worth the user's attention?
10.4 Threshold Policy
Do not invent an arbitrary precision target before collecting baseline data. Record precision from the first notification, establish the baseline, then set a formal target based on actual observed performance.
10.5 Acceptance Criteria
11. Implementation and Release Plan
11.1 Milestone 1 â€” Core Job Pipeline
PostgreSQL
Worker process
Source abstraction
3â€“5 adapters
RawJob
Normalization
URL validation
Description quality
Deduplication
SourceRun
Health checks
Exit condition: trustworthy jobs exist in PostgreSQL.
11.2 Milestone 2 â€” Deterministic Matching
Seeded candidate
Skills
Roles
Locations
Remote preference
Matcher
Score
Confidence
UNKNOWN handling
Evidence
Exit condition: real jobs receive explainable deterministic matches.
11.3 Milestone 3 â€” Telegram Loop
Telegram linking
Eligibility
Outbox
Delivery
View
Save
Reject
Apply/Open
Feedback
Exit condition: useful alerts arrive reliably.
11.4 Milestone 4 â€” AI Fallback
AiProvider
NoopProvider
OllamaProvider
Strict schemas
Triggers
AI evidence
Timeouts
Fallback
Exit condition: AI improves ambiguous cases without becoming required.
11.5 Milestone 5 â€” Reliability and Validation
Lifecycle sweeps
Link-rot checks
Backup
Restore
Operational metrics
14-day validation
Exit condition: real-world MVP validation is complete.
12. Post-MVP Roadmap
13. Risks and Mitigations
14. Engineering Rules
Appendix A. Core Enums
Lifecycle
ACTIVE | EXPIRED | REMOVED | NOT_FOUND
Calendar
GREGORIAN | ETHIOPIAN | UNKNOWN
SalaryType
EXACT | RANGE | STARTING_FROM | UP_TO | NEGOTIABLE | NOT_DISCLOSED | AS_PER_SCALE | UNKNOWN
LocationCategory
ADDIS_ABABA | ETHIOPIA_CITY | ETHIOPIA_REGION | ETHIOPIA_REMOTE | INTERNATIONAL_REMOTE | INTERNATIONAL_ON_SITE | HYBRID | UNKNOWN
EvidenceState
KNOWN | UNKNOWN | CONFLICTING
SkillEvidence
EXACT_MATCH | CANONICAL_ALIAS | RELATED_SKILL | TRANSFERABLE | AI_SUGGESTED | UNKNOWN
AIStatus
SUCCESS | TIMEOUT | UNAVAILABLE | INVALID_OUTPUT | SCHEMA_ERROR | PROVIDER_ERROR | FALLBACK
NotificationStatus
PENDING | PROCESSING | SENT | FAILED | CANCELLED
Appendix B. Example Data Objects
B.1 Salary
{
  "salaryType": "RANGE",
  "salaryMin": 50000,
  "salaryMax": 70000,
  "salaryCurrency": "ETB",
  "salaryPeriod": "MONTH",
  "salaryEvidence": "50,000â€“70,000 ETB per month",
  "salaryConfidence": 0.94
}
B.2 Ethiopian date
{
  "originalPublishedDateText": "áˆ˜áˆµáŠ¨áˆ¨áˆ 5, 2018",
  "publishedCalendar": "ETHIOPIAN",
  "publishedAt": "deterministically converted Gregorian date",
  "dateConfidence": 0.99,
  "conversionMethod": "ETHIOPIAN_CALENDAR_V1"
}
B.3 Match
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
  "matchedSkills": ["TypeScript", "React", "Node.js"],
  "missingSkills": ["Kubernetes"],
  "uncertainSkills": ["AWS"],
  "matcherVersion": "1.0.0"
}
B.4 AI evidence
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
Appendix C. Definition of Done
Clean database migration succeeds.
At least 3 real sources operate.
Raw source evidence is inspectable.
Normalization and deduplication have tests.
Ethiopian date and salary fixtures pass.
Matcher is deterministic and versioned.
UNKNOWN behavior is tested.
AI can be disabled.
AI failures do not stop the pipeline.
API and Worker are separate processes.
Worker work is persistent/recoverable.
Telegram uses an outbox.
Feedback is recorded.
Source health catches unexpected zero-result runs.
Backup restore is tested.
14-day real-world validation is completed.
Notification Precision is measured and documented.
Appendix D. Final Product Definition
JobHunter v1.0 is successful when it can reliably turn fragmented job postings into a small stream of trustworthy opportunities.
SOURCE
  â†“
RAW DATA
  â†“
NORMALIZE
  â†“
VERIFY
  â†“
STRUCTURE
  â†“
AI ONLY WHEN NEEDED
  â†“
MATCH DETERMINISTICALLY
  â†“
CONFIDENCE
  â†“
FILTER
  â†“
TELEGRAM
  â†“
USER FEEDBACK
  â†“
NOTIFICATION PRECISION
The first objective is not to build a large job platform. It is to prove that the user can trust JobHunter's alerts. Once that is demonstrated, multi-user support, queues, semantic matching, advanced AI, application tracking, and learned ranking can be added as evidence-driven expansions.
Document Type | Software Requirements Specification
---
Version | 1.0
---
Status | Implementation Baseline
---
Stage | MVP / Validation
---
Primary User | One seeded candidate
---
Primary Channel | Telegram
---
Database | PostgreSQL
---
Worker | Separate Node.js worker process
---
AI | Optional, on-demand, advisory
---
Primary KPI | Notification Precision
---
Geographic Priority | Ethiopia â†’ Remote â†’ International
---
Version | Date | Change | Status
---
1.0 | 2026-10-04 | Reorganized into a conventional industry SRS structure while preserving v1.0 product requirements. | Baseline
---
Term | Meaning
---
SRS | Software Requirements Specification
---
MVP | Minimum Viable Product
---
AI | Artificial Intelligence
---
API | Application Programming Interface
---
KPI | Key Performance Indicator
---
NFR | Non-Functional Requirement
---
HTTP | Hypertext Transfer Protocol
---
RSS | Really Simple Syndication
---
URL | Uniform Resource Locator
---
LLM | Large Language Model
---
UNKNOWN | A valid state when required evidence cannot be established
---
Method | Endpoint | Purpose
---
GET | /api/jobs | List jobs
---
GET | /api/jobs/:id | Job detail
---
GET | /api/matches | List matches
---
GET | /api/matches/:id | Match evidence
---
GET | /api/profile | Candidate profile
---
PUT | /api/profile | Update profile
---
GET | /api/notifications | Notifications
---
POST | /api/notifications/:id/feedback | Feedback
---
POST | /api/telegram/link | Telegram link token
---
GET | /api/sources | Source health
---
POST | /api/sources/:id/run | Manual source run
---
ID | Area | Requirement
---
FR-001 | Sources | Represent enabled sources, adapter type/version, schedule, access policy, and health.
---
FR-002 | Collection | Collect enabled sources on schedule.
---
FR-003 | Isolation | A source failure must not stop other sources.
---
FR-004 | Raw data | Preserve source evidence sufficient for debugging/reprocessing.
---
FR-005 | Normalization | Normalize every collected job before matching.
---
FR-006 | URLs | Normalize and verify application targets.
---
FR-007 | Description | Classify description quality and reject/flag unusable content.
---
FR-008 | Deduplication | Detect duplicates using multiple signals.
---
FR-009 | Extraction | Extract key fields deterministically when possible.
---
FR-010 | AI | Invoke AI only for explicit ambiguity/missing-data triggers.
---
FR-011 | Provenance | Retain provenance/evidence for important fields.
---
FR-012 | Profile | Maintain one candidate matching profile.
---
FR-013 | Matching | Calculate reproducible deterministic match score.
---
FR-014 | Confidence | Calculate evidence/extraction confidence separately.
---
FR-015 | Explainability | Expose matched, missing, and uncertain evidence.
---
FR-016 | Notifications | Notify only eligible active jobs.
---
FR-017 | Outbox | Use persistent notification delivery state.
---
FR-018 | Feedback | Record relevant/not relevant/unsure feedback.
---
FR-019 | Lifecycle | Detect expired, removed, and dead jobs.
---
FR-020 | Health | Detect abnormal source behavior.
---
FR-021 | Backup | Run scheduled database backups.
---
FR-022 | Recovery | Recover persistent worker work after restart.
---
Factor | Weight
---
Role | 25%
---
Skills | 30%
---
Experience | 15%
---
Location | 15%
---
Employment | 5%
---
Freshness | 5%
---
Salary | 5%
---
Evidence | Credit policy
---
EXACT_MATCH | Full credit
---
CANONICAL_ALIAS | Full credit
---
RELATED_SKILL | Partial, capped
---
TRANSFERABLE | Lower partial, capped
---
AI_SUGGESTED | Confidence-gated and capped
---
UNKNOWN | No positive credit
---
Value | Meaning | Authority
---
GREGORIAN | Gregorian date explicitly identified | Source/deterministic
---
ETHIOPIAN | Ethiopian calendar identified | Deterministic conversion
---
UNKNOWN | Cannot establish calendar/date | No guessing
---
SalaryType | Example | Canonical numeric value?
---
EXACT | 50,000 ETB/month | Yes
---
RANGE | 50,000â€“70,000 ETB/month | Yes
---
STARTING_FROM | Starting from 50,000 ETB | Minimum
---
UP_TO | Up to 70,000 ETB | Maximum
---
NEGOTIABLE | Salary negotiable | No
---
AS_PER_SCALE | As per scale | No
---
NOT_DISCLOSED | Not disclosed | No
---
UNKNOWN | Could not determine | No
---
ID | Area | Acceptance
---
AC-001 | Collection | At least 3 real sources collect independently.
---
AC-002 | Isolation | Failed source does not stop others.
---
AC-003 | Traceability | Every accepted job traces to raw source evidence.
---
AC-004 | Application | Every notified job has a usable application path.
---
AC-005 | Duplicates | Known duplicate fixtures are handled correctly.
---
AC-006 | Dates | Ethiopian dates convert deterministically; uncertain dates stay unknown.
---
AC-007 | Salary | Negotiable/as-per-scale/unknown never become fabricated numbers.
---
AC-008 | Location | Missing location remains UNKNOWN.
---
AC-009 | Matcher | Same input/version produces same output.
---
AC-010 | UNKNOWN | Unknown does not automatically become negative evidence.
---
AC-011 | AI off | Pipeline works with AI_PROVIDER=noop.
---
AC-012 | AI failure | Timeout/invalid output falls back safely.
---
AC-013 | Isolation | Heavy work is outside API request handling.
---
AC-014 | Restart | Pending work remains recoverable after worker restart.
---
AC-015 | Telegram | Eligible notifications use persistent outbox.
---
AC-016 | Duplicates | Equivalent notification event is not repeatedly delivered.
---
AC-017 | Feedback | User can classify delivered alerts.
---
AC-018 | Health | Unexpected zero-result runs are visible.
---
AC-019 | Backup | Backup can be restored.
---
AC-020 | Validation | 14-day notification precision is measured.
---
Phase | Addition | Justification
---
2 | Redis/BullMQ | PostgreSQL work coordination becomes a measured bottleneck.
---
2 | Multi-user | Personal validation proves repeated value.
---
2 | CV parsing | Manual profile setup becomes a bottleneck.
---
2 | Application tracking | Notification-only workflow becomes insufficient.
---
2 | Saved-search automation | Users demonstrate need for automated queries.
---
3 | pgvector | Deterministic matching shows measured semantic limitations.
---
3 | Learned ranking | Enough behavioral feedback exists.
---
3 | External AI | Local quality/performance is insufficient and privacy is addressed.
---
3 | Email/PWA/mobile | Observed usage justifies additional channels.
---
Risk | Impact | Mitigation
---
Source layout changes | High | Adapter isolation, fixtures, health/drift alerts.
---
Expired/dead jobs | High | URL checks and lifecycle sweeps.
---
Poor extraction | High | Raw evidence, deterministic parsing, confidence, selective AI.
---
AI hallucination | High | Advisory AI, strict schema, provenance, capped evidence.
---
CPU-heavy local AI | Medium | On-demand calls, worker isolation, per-run cap.
---
Telegram rate limits | Medium | Outbox and retry/backoff.
---
Worker/power restart | Medium | Persistent task state and catch-up.
---
Source proliferation | High | 3-5 source MVP limit.
---
Overengineering | High | Validation gate before expansion.
---
Privacy leakage | High | Ownership checks and explicit external-AI consent.
---
Backup failure | High | Off-machine backup plus restore test.
---
