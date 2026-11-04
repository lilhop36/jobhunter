# Application links: what the pipeline actually stores and shows

**Date:** 2026-11-04
**Type:** investigation, report-only. No code, SRS or ADR change.
**Relates to:** FR-006, SRS 7.7 step 7, AC-004, SRS 3.2 (message content), SRS 3.2 match detail,
D10, D13, AC-017.
**Evidence base:** committed code at `461e6c9`; one read-only query pass over the dev database
(`jobhunter`, 230 jobs, captured 2026-10-15 → 2026-11-04). No external URL was fetched — see §7.

---

## 1. The question

A "link to apply" is not one thing. Three distinct links are routinely conflated:

| # | Link | Whose it is | Example from the live data |
| --- | --- | --- | --- |
| 1 | **Source listing URL** — the page we scraped | the aggregator | `https://ethiojobs.net/job/LbHGyIHbeV-senior-trainer-construction-technologist` |
| 2 | **Employer vacancy page** — the employer's own posting | the employer | (not modelled — see F3) |
| 3 | **Application form URL** — where the CV actually goes | the employer or a form service | `https://forms.gle/wFRUJFTAiJiC8M3s5` |

For a job seeker only #3 is actionable. For data provenance only #1 is authoritative. This report
establishes which of the three the system holds, how each is derived, and where the chain breaks.

## 2. What the SRS requires

| Requirement | Text | Consequence here |
| --- | --- | --- |
| FR-006 | "Normalize **and verify** application targets." | Normalisation is implemented; **verification is not** (D10). |
| 7.7 step 7 | "Validate description/application target." | Implemented as `hasUsableApplicationPath`. |
| AC-004 | "Every notified job has a usable application path." | Enforced in `evaluateNotificationEligibility`. |
| 3.2 content | Message carries the application path. | Implemented as an `Apply:` line. |
| 3.2 actions | `VIEW \| SAVE \| REJECT \| APPLY / OPEN / COPY EMAIL`. | Not built (D13). |
| Match detail | Show "…description quality, and application path". | Implemented on `/matches/:id` and `/jobs/:id`. |

The SRS does not define how a method is detected, and it does not say whether "verify" means
syntactic validity or a live HTTP probe. That ambiguity is the root of D10 and is the decision
requested in §9.

## 3. What each stage does today

| Stage | Location | Behaviour |
| --- | --- | --- |
| Declared extraction (Ethiojobs) | `src/infrastructure/adapters/ethiojobs.ts` `mapDeclaredApplication` | Maps the publisher's own `applicationMethod` field for `EMAIL`, `CAREER_PAGE_LINK`, `BOTH` only. `ATS` maps to nothing; `IN_PERSON` and `application_form` are not read at all. |
| Text extraction (EffoySira, JobWebEthiopia) | `src/domain/normalizers/application-target.ts` `APPLICATION_TARGET_V1` | An HTTP(S) URL or `mailto:`/address within an 80-char apply-keyword window. High precision, low recall, by design. |
| Precedence | `src/infrastructure/adapters/normalize-evidence.ts` | Declared target wins over extracted; extracted is the fallback. |
| Storage | `src/infrastructure/ingestion/prisma-job-repository.ts` | Writes `applicationMethod`, `applyUrl`, `applyEmail`; provenance recorded for the two values. On re-observation, `keepWhenAbsent(applyUrl/applyEmail)` and `keepWhenUnstated(applicationMethod)`: a capture that reads nothing leaves the stored fact alone. |
| Eligibility | `src/domain/notification/notification-eligibility.ts` | `NO_USABLE_APPLICATION_PATH` blocks notification unless `allowInformationalListings` is set (off). |
| API | `apps/api/routes/jobs.ts` `serializeJobDetail` | Returns `applicationMethod`, `applyUrl`, `applyEmail`. |
| Web UI | `apps/api/routes/web.ts` | `/jobs/:id` shows `Application: <method>: <url>` and a separate `Canonical URL` row. There is **no Apply button**; the job list links only to `/jobs/:id`. |
| Notification | `src/domain/notification/notification-message.ts` `formatApplication` | `Apply: <applyUrl \| applyEmail \| UNKNOWN \| "in person" \| …>`. The message contains **no listing URL** — `Source:` is the source's name, not a link. |

Everything above is deliberate and each step has tests. The defects are in coverage, not in
carelessness.

## 4. What the live data shows (230 jobs)

### 4.1 Method distribution

| Method | Jobs | Share |
| --- | --- | --- |
| `EMAIL` | 91 | 40% |
| `UNKNOWN` | 75 | 33% |
| `ONLINE_URL` | 61 | 27% |
| `IN_PERSON` | 3 | 1% |

All 230 are `ACTIVE` except 8 `EXPIRED`; none are `REMOVED` or `NOT_FOUND`, so nothing here is
confounded by the lifecycle work.

**33% of the corpus cannot be notified at all.** That is the headline, and it is a mapping gap
more than a data gap (§4.3).

### 4.2 The 61 apply URLs, by destination

Zero of the 61 share the listing's host: not one is just the scraped page under another name.
Classified by destination:

| Destination type | Jobs | Reading |
| --- | --- | --- |
| Google Forms (`forms.gle`, `docs.google.com/forms`) | 23 | A real application form. Legitimate; opaque until resolved (the `forms.gle` short link must be followed to name its owner). |
| Employer ATS | 9 | Workday, SuccessFactors, Oracle Cloud, Salesforce Sites, Flair, SAP HR Cloud. Exactly what a verified apply link should be. |
| Employer's own career page / server | 10 | e.g. `jobs.addisbanksc.com`, `erp.orointbank.com.et`, `careers.ecoet.org`, `http://196.189.151.126/open-vacancies`. Legitimate, though the bare-IP host cannot carry a valid certificate. |
| Another job board | 8 | `ethiojobs.net/companies/<employer>/jobs`, reached from an EffoySira post that says "submit … through the Ethiojobs recruitment platform". The publisher names a *platform*, not a form; this is closer to `SOURCE_ACCOUNT` than to `ONLINE_URL`. |
| Telegram channel | 7 | `t.me/...`. A genuine Ethiopian application channel ("send your CV to our Telegram"), but not a form and not verifiable as one. |
| Google Maps pin | 2 | `maps.app.goo.gl/…` on two "Invitation for Bids" notices. **Wrong**: a location, not an application target. |
| Unresolved shortener | 2 | `rb.gy/3rtgvg`. Target unknown; resolving requires a network fetch. |

So roughly 42 of 61 are plausibly a true application destination, 17 are a real channel of a
different kind, and 2 are outright false.

### 4.3 Why 75 jobs are `UNKNOWN` — and how much is our fault

Joining the stored payload to the stored verdict:

| Cause | Jobs | Current code? | Verdict |
| --- | --- | --- | --- |
| Publisher declared `ATS`, which the adapter does not map | 27 | yes | **Our gap.** `ATS` on Ethiojobs means "apply on Ethiojobs", i.e. `SOURCE_ACCOUNT`, whose path is the listing URL we already hold. No fabrication needed. |
| Publisher declared `IN_PERSON`, which the adapter does not map | 5 | yes | **Our gap.** The enum value exists and `hasUsableApplicationPath` already treats it as usable. |
| EffoySira post with no application signal at all | 24 | yes | Correct. Absence of evidence stays `UNKNOWN`. |
| Captured 2026-10-22, before the declared-field mapper landed (`af02176`, 2026-10-23) | 19 | no | **Stale data.** 13 declared a valid email, 6 a valid link. Self-corrects when the posting's content next changes (the upsert refreshes stated fields on fingerprint change); until then the old verdict stands. |

32 of the 75 are therefore recoverable by mapping, not by collection. That single change would take
notifiable coverage from 67% to 81% of the corpus **without inventing a single URL** — mapping
`ATS`→`SOURCE_ACCOUNT` and `IN_PERSON`→`IN_PERSON` records what the source already stated, with
the listing URL as the path we already store.

### 4.4 The two false links are source-declared, not extracted

Both `maps.app.goo.gl` cases carry `applicationMethod=CAREER_PAGE_LINK` and
`careerPageLink=https://maps.app.goo.gl/…` in their preserved raw payload. The text extractor is
not at fault: `mapDeclaredApplication` canonicalises the declared link and trusts it. So the
declared field is source-asserted, not verified — a publisher can put anything in it. This is the
concrete reason FR-006 asks for *verification*.

### 4.5 The missing third link

No job in the corpus stores the employer's own vacancy page as distinct from either the listing or
the application target. For EffoySira the stored `canonicalUrl` is the blog post; the employer page
it summarises is not modelled. For the 8 "other board" cases the intermediary page is the only
employer-side artefact we ever see, and we file it as the application target.

Consequence: when the application target is unverifiable — a dead `forms.gle`, an expired ATS
requisition — there is no stored fallback but the aggregator's listing, which for EffoySira is not
even the employer's text.

## 5. Findings

| Ref | Finding | Severity | Fix shape |
| --- | --- | --- | --- |
| A1 | Declared `ATS` is dropped, so 27 jobs are permanently ineligible for notification although the source states a usable path. | high (product) | Map `ATS`→`SOURCE_ACCOUNT`. Cheap, no fabrication, needs a product decision on what the message should say. |
| A2 | Declared `IN_PERSON` is dropped; 5 jobs ineligible; 3 others only recovered by accidental text extraction. | medium | Map `IN_PERSON`. |
| A3 | No application target is ever verified (D10). 2 live links are known-wrong, 2 are unresolved shorteners, and 7 Telegram links are being presented as if they were forms. | medium | Needs the D9 request budget and an ADR (see §7). |
| A4 | Notification carries no listing URL. For an `UNKNOWN`-method job a Telegram reader has no clickable route to the posting at all, and for every job no route to the source. | medium | Add the listing URL as a line or a `VIEW` button — but that is D13's `reply_markup` work. |
| A5 | The declared field is trusted for *meaning*, not just for *presence*: a publisher's map pin becomes `ONLINE_URL`. | low (data integrity) | A verification step is the real fix; a cheap partial guard is a host/kind discriminator (§6). |
| A6 | 19 rows carry a verdict the current adapter would no longer produce, and only a content change will refresh them. | low | No action needed if A1/A2 land; mention in status reporting so nobody reads the 33% as steady-state. |

## 6. Proposed design (not implemented)

Bounded, three parts, each independently shippable and each refusing to fabricate:

1. **Map the declared methods the source already emits** (A1, A2). `ATS`→`SOURCE_ACCOUNT`,
   `IN_PERSON`→`IN_PERSON`, keep `EMAIL`/`CAREER_PAGE_LINK`/`BOTH`. Nothing is inferred from
   absent fields, and `hasUsableApplicationPath` already knows what each method needs.
2. **Record what kind of destination an `ONLINE_URL` is** (A5), as a deterministic classification of
   the link itself — form host, ATS, shortener, social/messaging, other board, bare host — stored
   next to the URL with the evidence it was derived from. This is not verification and must not be
   presented as such; it stops a map pin from being rendered as "online application" and lets the UI
   say "opens a Telegram channel" honestly. `UNKNOWN` stays a valid outcome.
3. **Fall back, never invent** (A3, A4). When the target is missing or later found dead, surface the
   listing URL we do hold and say the application path is unconfirmed. The message gains the listing
   link either way; that is D13 and should be done with the button work, not before it.

Verification proper (FR-006's "verify") stays out of scope until the owner sets a request budget,
because it spends the same politeness budget as collection and a timeout is not proof of death —
the same argument ADR-0010 §6 already makes for `NOT_FOUND`.

## 7. What this investigation deliberately did not do

- **No external request was made.** Every URL above was read from the database as text. Resolving
  `rb.gy` or `forms.gle` would spend the budget D9 is waiting on, and probing third-party hosts
  during an audit is exactly the behaviour ENG-019 constrains.
- **No code, SRS or ADR edit.** A1–A6 are reported. Two of them (A1, A2) change what becomes
  notifiable, which is a product decision, not a bug fix.
- **No replayed collection.** These rows are the dev database's history, not a fresh run of the
  current adapter; §4.3's "current code?" column is inferred from the adapter source and the row
  timestamps, not from a live recollect.
- **No measurement of how many apply links are already dead.** That is precisely the probe that does
  not exist (D10/D9).

## 8. Verification of this document

- Every number in §4 is reproducible with a read-only `SELECT` over `jobs` ⋈ `raw_jobs` ⋈
  `job_sources`; the classification buckets sum to the 61 `ONLINE_URL` jobs and the `UNKNOWN`
  breakdown sums to 75.
- Every code claim in §3 was read from the file named in the same row at `461e6c9`.
- The 19 stale rows were dated against `git show -s --date=iso af02176` (2026-10-23) and the rows'
  `createdAt` (2026-10-22), and the refresh rule was read from `JOB_REFRESH_COLUMNS`.

## 9. Decisions requested

| # | Decision | Options |
| --- | --- | --- |
| 1 | Is a source-declared `ATS` a usable application path (`SOURCE_ACCOUNT`), with the listing URL as the path? | yes → A1 becomes a small mapped change; no → 27 jobs stay ineligible and the message should say why |
| 2 | Does FR-006 "verify" mean a syntactic/kind check (part 2 of §6) or a live HTTP probe (needs budget + ADR)? | kind check now, probe later, or probe now |
| 3 | Should the notification carry the listing URL before D13's buttons exist? | yes as a text line; no until buttons |
