# Deep Research: Systems With the Same Purpose as JobHunter

> Generated 2026-10-27 | Depth: standard | Sources: 29

## TL;DR

JobHunter's hardest problems — adapters that decay, postings that disappear without saying "closed", the same vacancy syndicated across boards, and explaining a match score — are solved elsewhere, but rarely all in one system. The closest public analogues each solve one layer well and punt on the rest: JobSpy and JobFunnel are stateless collectors, ATS APIs expose only live listings [3][4][5], and ATS products hide their matching formulas [13][14][15]. The strongest transferable pattern is a **staged, reversible pipeline with explicit UNKNOWN states** — cheap exact keys before fuzzy similarity, publisher-asserted expiry before disappearance-based expiry, deterministic scores before any generative explanation — which is already JobHunter's stated philosophy and is worth defending rather than replacing.

## Executive Summary

The survey covered six areas: open-source scrapers and aggregators, ATS public APIs, data-quality and freshness practice, deterministic and semantic matching, canonical skill/location vocabularies, and the Ethiopian/African market. The evidence supports four conclusions that bear directly on JobHunter.

First, **collection layers in the wild are thin and stateless**. JobSpy fans out to nine boards through one call and returns a DataFrame with no deduplication and no observation history [1]; JobFunnel compresses scraped listings into CSVs and is now archived because board operators moved to aggressive anti-automation [2]. Neither models re-observation, merging, or lifecycle. JobHunter's raw-evidence-before-promotion design is therefore not over-engineering relative to the field — it is the differentiator, and the research gives no reason to relax it.

Second, **"the posting vanished" is the weakest available expiry signal, and the ecosystem treats expiry as a publisher assertion**. Google's structured-data policy requires a closed job to be expired explicitly — `validThrough` in the past, a 404/410, or removal of the markup [21] — while the public ATS APIs return only *published* postings, with no documented updated-since feed in the public board APIs [3][4][5]. That combination means an aggregator cannot distinguish "the employer closed it" from "the API hiccupped" without a grace window. JobHunter's coverage-aware retirement (only a run that actually read the listing may retire anything) is the correct architecture; the research validates it and cautions against counting a single miss as closure.

Third, **dedupe and matching both work best as staged pipelines with a cheap, explainable first pass**. Peer-reviewed work on job-posting deduplication describes multi-stage blocking followed by similarity scoring [7], with similarity alone shown to be insufficient without domain knowledge [8]; industry practice normalises title, company and location before collapsing cross-source duplicates [9][10]. On matching, the one detailed public design splits a deterministic weighted scoring layer from a generative explanation layer, feeding the LLM only pre-computed scores so explanations cannot invent facts [12]. That is the pattern JobHunter already mandates in AGENTS.md, and the research supplies a concrete component breakdown to borrow in structure — not in weights.

Fourth, **the Ethiopian market context is fragmented, deadline-driven, salary-opaque and adversarial**. Ethiopian portals are small and largely HTML-only, salary is usually undisclosed, and EffoySira already re-publishes its vacancies to Telegram [25][26][27]. Employer impersonation on job platforms is documented by the FBI's IC3 [28] and Ethiopian employers have publicly disclaimed fake ads in their name [29]. UNKNOWN salary and untrusted input are not edge cases here; they are the normal condition.

The main gap found is negative rather than positive: no public engineering information exists for how the Ethiopian platforms are built, and no source quantified the accuracy of deterministic versus semantic matching. Those remain open questions rather than recommendations.

## 1. Status Quo [Confidence: High]

### 1.1 Collection: one core, many brittle adapters

The dominant open-source pattern is a single package with one module per board, a uniform in-memory result shape, and one entry point that fans out concurrently. JobSpy covers LinkedIn, Indeed, Glassdoor, Google, ZipRecruiter, Bayt, Naukri, BDJobs and HelloWork behind a single call, returning a DataFrame or CSV, with proxy support and per-board rate-limit handling [1]. JobFunnel followed the same shape for Indeed, Glassdoor and LinkedIn across locales, deduplicating only by each board's native job ID and running from cron with deliberate delays — and is archived, with its own README attributing that to boards' "much more aggressive anti-automation and bot-detection" [2].

Three lessons follow. Adapters must fail independently: a single shared scraping core turns one board's redesign into a total outage, whereas per-source modules isolate blast radius (JobSpy's own reported ceilings are per-board — LinkedIn throttles after roughly ten result pages, Indeed calls hang [6]). HTML scraping decays structurally: the archived project is the strongest available evidence that "respectful pacing" is not a mitigation strategy [2][11]. And collector output is not a data store: none of these projects document re-observation semantics, merge rules, or absence handling, because none of them persist observations at all [1][2][6].

The ATS public APIs are the stable alternative where they exist. Greenhouse exposes a token-scoped JSON API of a company's offices, departments and *published* jobs [3]; Lever documents a public Postings REST API intended for building custom job sites, with no documented per-posting `updatedAt` in the postings payload, so change detection must fall back to content hashing [4]; Ashby exposes `GET /posting-api/job-board/{JOB_BOARD_NAME}`, returns only listed postings, and includes compensation only when `includeCompensation=true` is requested [5]. These are tenant-scoped rather than global-search APIs, so an aggregator must enumerate company boards, not query a marketplace [3][5]. Salary is the least standardised field across all of them [4][5].

A verification caveat matters here: the "no delta feed" statement is true of Greenhouse's *public Job Board API*, but Greenhouse's authenticated Harvest API does expose `updated_at` filtering. For a public-only ingester the practical conclusion stands; it would be wrong to generalise it to every Greenhouse API.

### 1.2 Expiry is a publisher assertion, not a crawler inference

Google's JobPosting documentation is the clearest normative statement in the ecosystem: a job no longer open "must be expired" by populating `validThrough` in the past, removing the page so it returns 404/410, or removing the structured data [21]. The recommended field set — title, description, `datePosted`, `validThrough`, hiring organisation, job location, base salary — maps almost one-to-one onto JobHunter's canonical model.

Because ATS APIs return only live postings [3][4][5], a crawler's only other signal is disappearance. That signal is ambiguous by construction: a removed posting, a paused posting, a filtered response and a transient API failure all look identical. The practical corollary is a grace window — treat absence as evidence only after repeated misses, and prefer a publisher-asserted expiry wherever one exists [3][4][5][21] — which is consistent with JobHunter's rule that a run may retire a job only when that run actually read the listing.

### 1.3 Dedupe: cheap keys first, similarity second

Peer-reviewed work frames job-posting deduplication as a multi-stage methodology for large heterogeneous datasets [7]; separate work shows character-overlap similarity alone is insufficient and that combining overlap with domain knowledge improves duplicate detection [8]. Industry vendors describe the same first step — normalise title, company and location, then collapse the same advertisement found on multiple sources [9] — and Indeed states plainly that it deduplicates jobs collected from multiple sources so each is counted once [10]. At web scale, the canonical fingerprinting technique is 64-bit SimHash with near-duplicates identified by small Hamming distance, using permutation tables for sub-linear lookup [22].

The important architectural point is that fingerprinting is a **candidate generator**, not a decision. Every credible design keeps a verification step, and JobHunter's provenance-preserving model requires one anyway: a merge must be reversible and must say which source contributed which fact.

### 1.4 Matching: deterministic scores, generative explanations

The most detailed public design found — JobMatchAI — explicitly separates "a deterministic scoring layer from a generative explanation layer", computes six fixed-weight components (Skill 0.35, Experience 0.25, Location 0.15, Salary 0.10, Semantic 0.10, Company 0.05), and gives the LLM only those pre-computed scores plus supporting evidence [12]. This was verified against the paper, which exists as an arXiv preprint (single-source; arXiv IDs do not imply peer review). The design rationale is auditability and hallucination prevention, not accuracy.

Comparative work sets machine-learned models against traditional keyword matching on CV-to-posting tasks [16], and benchmark studies confirm that semantic similarity results are measure- and corpus-dependent [24]. Nothing found justifies letting an embedding model hold ranking authority, and nothing found quantifies false-positive rates for either approach.

Applicant tracking systems solve the adjacent problem and are instructive for what they withhold. OpenCATS models candidates, job orders and contacts as separate aggregates, exposes postings through a careers portal and XML feeds, and treats resume parsing as a re-derivable capability rather than canonical data [13]. Odoo creates an applicant record automatically against a specific job position and runs a stage-based pipeline [14], but the scoring behind its Job Matching feature is not publicly specified, so an integrator can see that a match occurred without seeing why [15]. Neither publishes a general-purpose, explainable job-to-candidate scoring model — the gap JobHunter's rules exist to avoid.

One distinction deserves to be stated explicitly because JobHunter's own rules depend on it: a weighted-sum match score is a **relative fit** measure with no calibrated probability. No source supports presenting it as a likelihood of being hired, and none supports blending a model's self-reported certainty into it.

### 1.5 Canonical vocabularies: useful targets with known lags

ESCO provides stable concept URIs and APIs for search, suggest and concept detail over a multilingual skills/occupations taxonomy [17]; O*NET provides nearly 1,000 occupation descriptors with importance/level ratings under CC BY 4.0, updated continually [18]. Both give a defensible basis for weighting and for explaining a skill match.

Two cautions are well evidenced. ESCO is revised on a cycle measured in years, so emerging skills are simply absent — a practitioner test shows "prompt engineering" has no exact concept [19]. That makes an explicit unmapped/UNKNOWN outcome mandatory rather than optional: snapping to the nearest concept would fabricate a skill, which is the failure mode JobHunter's data-quality rules forbid. Second, the commonly repeated claim that ESCO matching uses preferred, alternative *and hidden* labels could not be verified in the cited pages; only preferred labels are documented there [17], so that mechanism should be treated as unverified until confirmed against ESCO's own specification.

Geography is harder than skills. Place-name resolution is fundamentally disambiguation, because many names are homonymic with ordinary words and with other places [20]. A string like "Addis" cannot be resolved by similarity alone; it needs an alias/gazetteer entry and a parent hierarchy (city → region → country), and it must return UNKNOWN when the mention is genuinely ambiguous. For Ethiopian free text — "Addis Ababa", "Addis", "AA", "Bole" — the sub-city and abbreviation cases make this concrete.

### 1.6 The Ethiopian and East African field

Ethiopian job distribution is fragmented across small portals: Ethiojobs self-describes as the leader with roughly 1,100 listings, HaHu Jobs carries roughly 800 and describes itself as "digital job vacancy aggregation, data driven job matching and Ethiopian labor market information data analytics and visualization" [25][26], and EffoySira/EffoyJobs runs a vacancy site that also publishes to a public Telegram channel [27]. The HaHu self-description makes it the closest conceptual competitor to JobHunter — aggregation plus matching plus labour-market analytics — though no engineering detail is public and its site serves a JavaScript shell with no readable static content.

Across these sources, postings are deadline-driven ("apply before X") and salary disclosure is the exception. That reinforces two JobHunter rules: salary must remain UNKNOWN rather than defaulted, and the application deadline is often the only machine-readable lifecycle fact available.

Fraud is a first-party concern in this market. The FBI's IC3 advisory documents scammers spoofing legitimate companies to post fraudulent job postings on employment platforms [28], and World Vision Ethiopia has publicly disclaimed fake job advertisements circulating in its name [29]. (An ICMPD article on fake ads targeting migrant workers was initially cited for an East African framing; verification showed it concerns Pakistan, so it is excluded here rather than misattributed.) The operational consequence is that company name is never sufficient provenance, and the source URL plus employer-contact evidence should be retained for every promoted listing.

### 1.7 Comparison at a glance

| System | Primary job | Collection | Re-observation / dedupe | Lifecycle | Matching | Lesson for JobHunter |
| --- | --- | --- | --- | --- | --- | --- |
| JobSpy [1] | Multi-board scraping | Per-board modules, one call | None; caller owns identity | None | None | Adapter shape is right; persistence must live outside it |
| JobFunnel [2] | Personal job search | HTML scraping, cron | Board-native ID only | None | None | HTML adapters perish; archived for anti-bot |
| Greenhouse / Lever / Ashby public APIs [3][4][5] | Employer job exposure | Tenant-scoped JSON | Stable posting ids; no public delta | Listed-only | None | Prefer APIs; absence is the only closure signal |
| OpenCATS [13] | ATS / recruiting CRM | N/A (receives applications) | Job order is the posting aggregate | Publish state on the posting | Recruiter search and tags | Keep posting lifecycle separate from application pipeline |
| Odoo Recruitment [14][15] | ATS with skills matching | N/A | Applicant created per position | Stage-based pipeline | Undocumented "Job Matching" | Unexplained scores are the failure mode to avoid |
| JobMatchAI [12] | Matching + explanation | N/A | N/A | N/A | Deterministic weights, LLM explains only | Separate scoring from explanation |
| Ethiojobs / HaHu [25][26] | Local market portals | HTML, self-reported volume | Not public | Deadline-driven | HaHu claims matching | Domain competitors; architecture unknown |
| EffoySira [27] | Local vacancies + Telegram | HTML, manual posting | Same vacancy on two surfaces | Deadline-driven | None | Telegram is a primary channel, and a second source surface |

Two rows deserve emphasis. The stateless collectors are not weak implementations of JobHunter; they are a different product class. Because they persist nothing across runs, they cannot answer "is this job new since I last looked?" — which is the entire basis of a notification. Any system that notifies must own an observation history, which is exactly the layer JobSpy and JobFunnel leave to the caller [1][2]. And the ATS rows show the opposite failure: posting lifecycle is modelled carefully, but the matching step is either recruiter-driven or opaque [13][14][15], so the explainability JobHunter requires is not something it can copy from them.

## 2. Emerging Trends [Confidence: Medium]

The clearest trend is **content-based health monitoring for collection pipelines**. Practitioner guidance converges on the position that HTTP 200 and "run completed" are meaningless: the dangerous failure is a run that reports success while returning empty or structurally wrong data. Concrete checks recur — record count against a trailing baseline, per-field null-rate spikes, freshness age of the newest record, and schema/selector validation — with one vendor guide alerting when row count drops by more than 30%, when null rate spikes, and when all records are older than 24 hours [23]. Data-quality tooling has moved in the same direction, treating volume and distribution anomalies as first-class, declarative expectations rather than bespoke scripts [24]. The figures are one vendor's defaults, not industry norms, and should be treated as starting points to calibrate per source.

The second trend is **separating scoring from explanation**, as in the deterministic-layer plus generative-layer split [12], alongside continued use of SimHash/MinHash-style fingerprints as the efficiency baseline that learned embeddings are measured against [8][22]. The third is **preferring structured publisher data where it exists**: ATS APIs and JobPosting structured data give stable identifiers and explicit expiry, which is why aggregators gravitate to them and away from consumer-board scraping [3][4][5][21].

A notable non-trend: none of the surveyed systems documents a coverage-window concept — whether a run read the whole listing or only a dated slice. JobHunter's coverage floor is therefore a genuine differentiator rather than an industry-standard control, and should be documented as such internally.

## 3. Critical Assessment [Confidence: High]

**Silent partial extraction is the dominant failure mode, and it is invisible without content assertions.** Layout drift, JavaScript-rendered content and selector changes do not raise errors; they produce fewer or emptier records. The scrapewise taxonomy names silent partial failure as the most dangerous class precisely because it corrupts downstream data without an exception [11], and the recurring practitioner diagnosis is "no monitoring" [23]. A zero-row run on a source that normally yields jobs must be a hard failure, not a valid empty result — which is what JobHunter's RESULTS_EXPECTED expectation already encodes.

**Disappearance-based expiry invites false closures.** Because public ATS feeds return only live postings and no delta [3][4][5], treating one missing observation as "closed" converts a transient failure into a negative fact. The ecosystem's answer — publisher-asserted expiry first, disappearance only after a grace window [21] — is the rule to keep.

**Cross-source dedupe is a data-quality problem, not a matching problem.** Similarity-only approaches are documented as insufficient [8], and every serious design normalises before comparing [9][10]. Without a reversible merge that preserves provenance, dedupe becomes silent data loss — the same class of harm as overwriting a known field with null.

**Semantic matching is a recall aid, not an authority.** Benchmarks are corpus-dependent [24], and the one detailed design gives semantic similarity a 0.10 weight while keeping deterministic components dominant [12]. A system that lets embeddings rank has traded explainability for an unquantified accuracy claim.

**Canonical vocabularies lag reality.** ESCO's multi-year revision cycle means emerging skills are unmapped [19]; a matcher that force-fits them to the nearest concept is fabricating evidence. O*NET's richer per-descriptor ratings help where its occupations cover the role, but neither taxonomy was designed for Ethiopian labour-market terminology.

**Adversarial input is the baseline, not the exception.** Spoofed employers [28] and fake ads in a major NGO's name [29] mean that "the source said so" is not verification. Any trust signal JobHunter displays must be derived from preserved provenance, never inferred from plausibility.

**A gap in the research itself:** no surveyed system documents notification-preference design, and this run did not allocate a retrieval agent to it. Notification architecture therefore rests on JobHunter's own requirements, not on external evidence.

## 4. Action Plan

- [ ] Keep per-source adapters independent, and record for each source whether it is API-backed or HTML-scraped; treat HTML adapters as perishable and expect to repair them [1][2].
- [ ] Where a source exposes a public ATS API (Greenhouse, Lever, Ashby), prefer it over HTML and store the source's stable posting id as the identity basis [3][4][5].
- [ ] Formalise lifecycle precedence as an explicit domain rule: publisher-asserted deadline or `validThrough` first, source-stated closure second, disappearance only after a grace window with repeated misses [21].
- [ ] Add cross-source dedupe in stages: canonicalised URL blocking, then a normalised (title, company, location) composite key, then SimHash on the description as a candidate generator with a reviewable threshold; every merge reversible and provenance-preserving [7][8][9][22]. This closes drift-register item D8.
- [ ] Implement the §7.8 yield-drift warning with a persisted per-source baseline (record count, null rate, newest-record age) and declarative thresholds rather than adapter-embedded checks [23][24]. This closes audit item H7.
- [ ] Populate `jobsRejected` from the real funnel instead of the hard-coded zero at `run-source-collection.ts:555`, otherwise the baseline above is computed from an incomplete counter.
- [ ] Keep matching deterministic and weighted-sum, with a separate explanation surface that receives only computed components and evidence — never raw job text for the model to summarise freely [12].
- [ ] Keep semantic similarity, if added, as a bounded, low-weight, explicitly labelled recall component, never the ranking authority [12][24].
- [ ] Resolve skills against ESCO/O*NET where a concept exists, recording the matched concept, the matching method, and an explicit UNKNOWN/unmapped state when none exists; do not snap to the nearest concept [17][18][19].
- [ ] Normalise locations through an alias table with a city → region → country hierarchy, returning UNKNOWN for genuinely ambiguous mentions; preserve the raw string alongside the resolved key [20].
- [ ] Display fraud-safety provenance on every promoted listing — original source URL and employer contact evidence — and never present company identity as verified when it is only asserted [28][29].
- [ ] Record in the engine documentation that coverage-window reporting is a JobHunter-specific control, since no comparable system documents it.

## 5. Open Questions & Caveats

No public API, schema, or engineering write-up was found for Ethiojobs, HaHu Jobs, EffoySira, JobWebEthiopia, Keajobs or Ethiojobszone. Claims about their volume are self-reported and unverified [25][26], and HaHu's architecture is unknown beyond its self-description [26].

No source quantified accuracy or false-positive rates for deterministic versus embedding-based matching [16][24], so the recommendation to keep deterministic authority rests on explainability requirements and design evidence, not measured superiority.

The monitoring thresholds (30% row drop, 24-hour freshness) come from one vendor guide [23] and must be calibrated against JobHunter's own run history rather than adopted as-is.

The ESCO alternative/hidden-label matching mechanism is widely repeated but was not verified in the cited documentation [17]; it is flagged as unverified rather than recommended.

JobMatchAI is a single arXiv preprint [12]; its weights are cited as a structural example, not as validated parameters.

An initial citation for East African fake-job-ad targeting was found on verification to describe Pakistan [29 excluded], so the Ethiopian fraud picture rests on the IC3 advisory [28] and one employer's public disclaimer [29], the latter single-source and Tier 3.

Notification-preference design was not covered by this retrieval wave and remains unresearched.

## Methodology

Depth: standard. Three retrieval agents ran in parallel (one each for open-source scrapers and ATS APIs; ATS products and matching; freshness, data quality and the African market), against a merged source budget of roughly 50 candidate references. After deduplication and tiering, 29 sources were retained. A separate verification agent fetched twelve high-impact claim–source pairs: ten were SUPPORTED, one PARTIAL, one UNSUPPORTED. Two corrections were applied before writing: the ESCO label-matching claim was narrowed to what the cited pages actually document, and an ICMPD article cited for East African fake ads was excluded because its subject is Pakistan. The outline was reduced from six to five evidence-backed areas because notification preferences had no retrieved evidence; that is recorded as an open question rather than padded with tangential sources.

## Bibliography

[1] speedyapply — JobSpy: jobs scraper library for LinkedIn, Indeed, Glassdoor and more — https://github.com/speedyapply/JobSpy — accessed 2026-10-27 — Tier: 2
[2] Paul McInnis — JobFunnel: scrape job websites into a single CSV — https://github.com/PaulMcInnis/JobFunnel — accessed 2026-10-27 — Tier: 2
[3] Greenhouse — Job Board API introduction — https://docs.greenhouse.io/job-board.html — accessed 2026-10-27 — Tier: 1
[4] Lever — Postings API documentation — https://github.com/lever/postings-api — accessed 2026-10-27 — Tier: 1
[5] Ashby — Public Job Posting API — https://developers.ashbyhq.com/docs/public-job-posting-api — accessed 2026-10-27 — Tier: 1
[6] Dvir Atias — JobSpy review: where it breaks — https://jobspipe.dev/blog/jobspy-review — 2026-07-13 — Tier: 3
[7] G. Thivaios et al. — On the Task of Job Posting Deduplication in Large Heterogeneous Datasets — https://www.mdpi.com/2078-2489/17/3/233 — 2026 — Tier: 1
[8] Anonymous — Combining Embeddings and Domain Knowledge for Job Posting Duplicate Detection — https://arxiv.org/html/2406.06257v1 — 2024-06-10 — Tier: 2
[9] Lightcast — Job Posting Analytics (JPA) Methodology — https://kb.lightcast.io/en/articles/6957446-job-posting-analytics-jpa-methodology — accessed 2026-10-27 — Tier: 2
[10] Indeed Hiring Lab — Indeed Data FAQ — https://hiringlab.indeed.com/indeed-data-faq-2/ — accessed 2026-10-27 — Tier: 2
[11] Scrapewise — Why web scrapers break: the five real causes — https://scrapewise.ai/learn/keep-scrapers-alive/why-scrapers-break — accessed 2026-10-27 — Tier: 3
[12] M. Vyas, A. Chakraborty, V. Gupta — JobMatchAI: An Intelligent Job Matching Platform Using Knowledge Graphs, Semantic Search and Explainable AI — https://arxiv.org/html/2603.14558v2 — 2026-03-18 — Tier: 1 (preprint; single-source)
[13] OpenCATS — Introduction and Overview (0.9.3 documentation) — https://opencats-documentation.readthedocs.io/en/latest/introduction.html — accessed 2026-10-27 — Tier: 2
[14] Odoo S.A. — Recruitment (Odoo 20.0 documentation) — https://www.odoo.com/documentation/20.0/applications/hr/recruitment.html — accessed 2026-10-27 — Tier: 1
[15] Odoo community forum — How does the Odoo 19 Job Matching feature work? — https://www.odoo.com/forum/help-1/how-does-the-odoo-19-job-matching-feature-work-289121 — 2025-10-22 — Tier: 3
[16] A. D. Stefanova — Machine Learning Techniques for Matching Candidates' CVs to Job Postings — https://openreview.net/pdf?id=NKeobAGKiA — accessed 2026-10-27 — Tier: 2
[17] European Commission — Use ESCO Services (API) — https://esco.ec.europa.eu/en/use-esco/use-esco-services-api — 2025-12-10 — Tier: 1
[18] U.S. Department of Labor / O*NET Center — O*NET Database — https://www.onetcenter.org/database.html — 2026-10-06 — Tier: 1
[19] JobsPipe — ESCO API: the EU's free skills and occupations API — https://jobspipe.dev/blog/esco-api — 2026-08-11 — Tier: 3
[20] B. Pouliquen et al. — Geographic Reference Resolution: Recognition, Disambiguation and Visualisation — https://arxiv.org/pdf/cs/0609065 — 2006 — Tier: 1 [foundational]
[21] Google Search Central — Job posting (JobPosting) structured data — https://developers.google.com/search/docs/appearance/structured-data/job-posting — accessed 2026-10-27 — Tier: 1
[22] G. S. Manku, A. Jain, A. D. Sarma — Detecting Near-Duplicates for Web Crawling — https://research.google.com/pubs/archive/33026.pdf — WWW 2007 — Tier: 1 [foundational]
[23] Context.dev — Scraper monitoring in production: a practical guide — https://www.context.dev/blog/scraper-monitoring-in-production — 2026-09-23 — Tier: 3
[24] Great Expectations — Why anomaly detection matters in data quality — https://greatexpectations.io/blog/why-anomaly-detection-matters-in-data-quality-and-how-gx-just-made-it-easier/ — 2025-07-02 — Tier: 2
[25] Ethiojobs — https://ethiojobs.net/ — accessed 2026-10-27 — Tier: 3
[26] HaHu Jobs — company description — https://et.linkedin.com/company/hahujobs — accessed 2026-10-27 — Tier: 3
[27] EffoySira / EffoyJobs — https://effoysira.com/ and https://t.me/s/effoyjobs — accessed 2026-10-27 — Tier: 3
[28] FBI IC3 — Scammers Exploit Security Weaknesses on Job Platforms (PSA220201) — https://www.ic3.gov/PSA/2022/PSA220201 — 2022-02-01 — Tier: 1
[29] World Vision Ethiopia — public fake-advisory post — https://www.facebook.com/WorldVisionEthiopia/posts/348536024390129/ — accessed 2026-10-27 — Tier: 3

## Source Extracts

### [1] JobSpy
- **Summary:** One call returns postings from LinkedIn, Indeed, Glassdoor, Google, ZipRecruiter, Bayt, Naukri, BDJobs and HelloWork, with concurrent per-site execution, proxy support and rate-limit handling; output is a DataFrame (CLI emits CSV/JSONL). The README contains no deduplication logic.
- **Key quotes:** "JobSpy is a job scraping library that aggregates jobs from popular job boards with one tool." Supported-site table lists `linkedin, zip_recruiter, indeed, glassdoor, google, bayt, bdjobs, naukri, hellowork`.
- **Source type:** open-source repository | **Tier:** 2

### [2] JobFunnel
- **Summary:** Python aggregator scraping Indeed/Glassdoor/LinkedIn across locales into CSV, deduplicating only by native job ID, running on cron with deliberate delays. Archived.
- **Key quotes:** boards "have moved to much more aggressive anti-automation and bot-detection."
- **Source type:** open-source repository | **Tier:** 2

### [3] Greenhouse Job Board API
- **Summary:** Token-scoped public JSON API exposing offices, departments and published jobs; the only documented parameter is `board_token`. No public delta feed. The authenticated Harvest API does expose `updated_at` filtering.
- **Key quotes:** "access to a simple JSON representation of your company's offices, departments, and published jobs."
- **Source type:** official documentation | **Tier:** 1

### [4] Lever Postings API
- **Summary:** Public REST API (`https://api.lever.co/v0/postings/{account}`) for building custom job sites; fields include title, categories, description HTML/plain, hosted/apply URLs; no documented per-posting `updatedAt` in the postings payload, so change detection falls back to content hashing.
- **Key quotes:** "This API is designed to help you create a job site."
- **Source type:** official documentation | **Tier:** 1

### [5] Ashby Public Job Posting API
- **Summary:** `GET /posting-api/job-board/{JOB_BOARD_NAME}`, no auth, listed postings only; `includeCompensation=true` adds tiered compensation; structured location and `publishedAt`.
- **Key quotes:** "This API allows you to get data for all currently published Job Postings"; "Optionally, you can add `includeCompensation=true`."
- **Source type:** official documentation | **Tier:** 1

### [6] JobSpy review
- **Summary:** Hands-on test reporting LinkedIn throttling around the tenth results page, Indeed calls hanging, and no caller-side dedupe. Vendor-authored, corroborated by [2].
- **Source type:** vendor blog | **Tier:** 3

### [7] Job posting deduplication (MDPI)
- **Summary:** Peer-reviewed multi-stage deduplication methodology for large heterogeneous job corpora; establishes exact-duplicate ground truth via full-field matching. Full text returned 403 during retrieval, so numbers were not used.
- **Key quotes:** "an efficient, multi-stage methodology"; exact duplicates confirmed "using full-field matching across company, title, location, and description."
- **Source type:** peer-reviewed article | **Tier:** 1

### [8] Embeddings and domain knowledge for duplicate detection
- **Summary:** Shows character-overlap similarity alone is insufficient; combining it with domain knowledge/embeddings improves duplicate detection in job descriptions.
- **Source type:** arXiv preprint | **Tier:** 2

### [9] Lightcast JPA methodology
- **Summary:** Vendor methodology describing normalisation of title, company and location before collapsing the same advertisement across sources.
- **Key quotes:** "we use normalized fields such as job title, company ..."
- **Source type:** vendor documentation | **Tier:** 2

### [10] Indeed Data FAQ
- **Summary:** States Indeed deduplicates jobs collected from multiple sources so each is shown once.
- **Key quotes:** "when the same job is collected from multiple sources we only show it once."
- **Source type:** official vendor page | **Tier:** 2

### [11] Why scrapers break
- **Summary:** Taxonomy of breakage — redesigns, bot walls, rendering changes, content drift, silent partial failure — with silent partial failure flagged as the most dangerous.
- **Source type:** vendor blog | **Tier:** 3

### [12] JobMatchAI
- **Summary:** Deterministic scoring layer (Skill .35, Experience .25, Location .15, Salary .10, Semantic .10, Company .05) separated from a generative explanation layer that receives only pre-computed scores and evidence. Verified against the paper; single-source.
- **Key quotes:** "deterministic scoring layer from a generative explanation layer."
- **Source type:** arXiv preprint | **Tier:** 1

### [13] OpenCATS documentation
- **Summary:** Open-source ATS covering candidates, job orders and contacts, with a careers portal and XML feeds; resume parsing is "currently lost but being developed," i.e. treated as a re-derivable capability.
- **Source type:** project documentation | **Tier:** 2

### [14] Odoo Recruitment
- **Summary:** An applicant card is created automatically against a specific job position on application; pipeline is stage-based. Publish state and any matching formula are not documented on the page.
- **Key quotes:** "an applicant card is automatically created … for that specific job position."
- **Source type:** official documentation | **Tier:** 1

### [15] Odoo 19 Job Matching forum thread
- **Summary:** Users note Odoo 19's Job Matching links job positions to required skills, but no public specification of the scoring formula or justification exists — a black box to integrators.
- **Source type:** community forum | **Tier:** 3

### [16] ML vs keyword matching for CVs
- **Summary:** Compares machine-learning models with traditional keyword matching on CV-to-posting tasks; framing useful, reproducibility unclear.
- **Source type:** OpenReview submission | **Tier:** 2

### [17] ESCO services API
- **Summary:** Search, suggest, concept-detail, relationship and mapping APIs over a multilingual skills/occupations taxonomy with stable concept URIs. The page documents preferred labels; alternative/hidden-label matching was not verified there.
- **Source type:** official documentation | **Tier:** 1

### [18] O*NET database
- **Summary:** Nearly 1,000 occupation descriptors including skill requirements with importance/level ratings, available in multiple formats under CC BY 4.0, updated continually.
- **Key quotes:** "a rich set of variables that describe work and worker characteristics, including skill requirements."
- **Source type:** government dataset | **Tier:** 1

### [19] ESCO API critique
- **Summary:** Notes ESCO is "updated on a revision cycle measured in years" and that "prompt engineering" does not exist in the taxonomy, supporting an explicit unmapped state for emerging skills.
- **Source type:** vendor engineering blog | **Tier:** 3

### [20] Geographic reference resolution
- **Summary:** Establishes place-name resolution as disambiguation: many names are homonymic with ordinary words and with other places, so a gazetteer plus contextual disambiguation is required.
- **Key quotes:** "Many place names are ambiguous in the sense that they are homonymic with other words in natural language."
- **Source type:** research paper | **Tier:** 1 [foundational]

### [21] Google JobPosting structured data
- **Summary:** Normative expiry policy for job pages and the canonical field set (title, description, datePosted, validThrough, hiringOrganization, jobLocation, baseSalary).
- **Key quotes:** "Jobs that are no longer open for applications must be expired in one of the following ways"; "Ensure the validThrough property is populated and in the past"; return "404 or 410"; "Remove JobPosting structured data."
- **Source type:** official documentation | **Tier:** 1

### [22] Detecting near-duplicates for web crawling
- **Summary:** Canonical SimHash reference: 64-bit fingerprints, near-duplicates by small Hamming distance, permutation tables for sub-linear lookup; fingerprints act as candidates requiring verification.
- **Key quotes:** "for a repository of 8B webpages, 64-bit simhash fingerprints and k = 3 are reasonable."
- **Source type:** peer-reviewed conference paper | **Tier:** 1 [foundational]

### [23] Scraper monitoring in production
- **Summary:** Argues successful-but-wrong runs are the dangerous failure; prescribes schema validation, canary checks, snapshot diffs and statistical thresholds. Verified code alerting on a >30% row-count drop, null-rate spikes, and records older than 24 hours.
- **Source type:** vendor engineering blog | **Tier:** 3

### [24] Great Expectations on anomaly detection
- **Summary:** Positions volume/distribution anomalies as declarative expectations rather than bespoke scripts. Page body is JS-rendered; snippet only.
- **Source type:** open-source project blog | **Tier:** 2

### [25] Ethiojobs
- **Summary:** Ethiopia's highest-volume portal by its own claim (~1,100 listings), organised by sector; no API or structured-data documentation found.
- **Source type:** primary site (metadata only) | **Tier:** 3

### [26] HaHu Jobs
- **Summary:** Self-describes as an aggregator with matching and labour-market analytics (~800 listings); the site is a JavaScript shell, so the phrase was verified on the company's LinkedIn profile instead.
- **Key quotes:** "Digital job vacancy aggregation, data driven job matching and Ethiopian labor market information data analytics and visualization."
- **Source type:** company profile | **Tier:** 3

### [27] EffoySira / EffoyJobs
- **Summary:** Addis Ababa vacancy site that also publishes the same vacancies to a public Telegram channel — one job, two distribution surfaces.
- **Source type:** primary sites | **Tier:** 3

### [28] FBI IC3 PSA220201
- **Summary:** Government advisory that scammers spoof legitimate companies to post fraudulent job postings on employment platforms.
- **Key quotes:** "Scammers spoof legitimate companies to post fraudulent job postings on commonly used employment-oriented networking sites."
- **Source type:** government advisory | **Tier:** 1

### [29] World Vision Ethiopia disclaimer
- **Summary:** A major NGO publicly disclaiming fraudulent job adverts circulating in its name, confirming impersonation is an active pattern in Ethiopia. Single source, social media.
- **Source type:** first-party social post | **Tier:** 3
