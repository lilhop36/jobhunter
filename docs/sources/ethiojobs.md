# Source approval record: Ethiojobs

- **Source:** Ethiojobs
- **Status:** APPROVED
- **Access mechanism:** STATIC_HTML
- **Robots and terms review:** robots.txt (2026-10-22) allows everything except `/auth/*`, `/api/*`, `/users/*`, `/companies/functions*` (an explicit `Allow: /` for `*` plus bot-specific allowances); the adapter therefore reads only `sitemap-jobs.xml`-listed `/jobs` listing pages and `/job/*` posting pages and never calls the disallowed `{*}`/api paths. Terms of Service (https://ethiojobs.net/terms-of-service) reviewed 2026-10-22 by the product owner: no clause blocking collection of listing/posting content with attribution and polite rate limits; verdict allowed.
- **Stable job identifier field:** the posting slug (`/job/<id>-<slug>`, e.g. `t8jXf0TiN5-driver-bishoftu`); the leading id segment is a stable external identifier (ADR-0001 id-bearing captures)
- **Declared calendar:** GREGORIAN
- **Declared currency:** none (no salary fields are published in structured data; in-text salary, when present, is plain text without a stated currency)
- **Canonical URL identity trusted:** yes
- **Expected results:** RESULTS_EXPECTED
- **Reviewed by:** product owner
- **Review date:** 2026-10-22

## Decision rationale

Ethiojobs (ethiojobs.net) is the largest Ethiopian job board, generating Addis Ababa and
national postings from private employers, NGOs and banks. robots.txt explicitly allows
listing and job pages, with a full per-job `sitemap-jobs.xml`. The site is a Next.js
application whose server-rendered pages embed the complete structured record for every
listing entry inside `__NEXT_DATA__` (and a schema.org `JobPosting` `ld+json` on each job
page), so the adapter captures posting data the publisher itself declares, rather than
heuristic text mining. The product owner read the Terms of Service on 2026-10-22 and
found no clause that blocks this collection.

## Notes

- **Discovery:** the `/jobs` listing (`/jobs?page=N`), newest first, 12 per page
  (`meta.lastPage` 94, total ≈1125 on 2026-10-22). `sitemap-jobs.xml` exists but its
  `lastmod` values are regenerated uniformly on every sitemap build (verified 2026-10-22:
  every entry carried the same generation timestamp), so recency is not derivable from the
  sitemap and the adapter does not use it.
- **Page shape varies by page number:** page 1 embeds `props.pageProps.jobs` as a plain
  array; page N embeds it as `{ data: [...], meta: {...} }` (verified live 2026-10-22).
  The parser accepts both.
- **Listing entry fields observed live (2026-10-22):** `slug`, `title`, `description`
  (full HTML), `state` (region text: "Addis Ababa", "Oromia", "Tigray", "Central Ethiopia
  Regional State", …), `date_published` (ISO), `date_expiry` (ISO — a real expiry date,
  unlike EffoySira), nested `company` (`name`, `email`, slug), `application_method`
  ("EMAIL"/"ATS"), `application_email` (null for ATS postings), `application_form`,
  `career_page_link`, `level` (career level code), `location_type`, `type`
  (employment-type code, no `type_name` on pages ≥2), `catalogs` (category names).
- **What stays UNKNOWN by capture (honest limits, not inferred):**
  - `type_name` (employment type text) is absent from the listing record; the shared
    employment classifier still mines the description text ("Employment Type: Full-Time"
    style lines, verified on the BS Technologies posting 2026-10-22).
  - Salary: no salary fields exist in the structured record; a colon/period salary line
    inside the description text ("Salary. Negotiable.") is the only in-text evidence,
    lifted as `rawSalaryText`.
  - `application_method`/`application_email` are structured fields, but the shared
    application-target policy is text-based (`APPLICATION_TARGET_VERSION`); ATS postings
    whose description carries no email/URL yield UNKNOWN and are therefore records with
    no usable application path (legitimately not notifiable). Wiring the structured
    fields into the versioned policy is a purposefully deferred follow-up change.
- **Structured capture (rawPayload):** the listing's structured non-text fields —
  `application_method`, `application_email`, `date_expiry`, `level`, `location_type`,
  `type`, category names, company email, opaque internal `id` — are preserved verbatim in
  `rawPayload` for later policy use and debugging; nothing is normalized from them yet
  (owner decision 2026-10-22: matcher wiring for skills/employment is a separate
  sign-off-gated increment).
- The job pages additionally embed a schema.org `JobPosting` `ld+json` block (title,
  description, employmentType, location, datePosted, `validThrough`, hiring organization);
  captured as well when the posting page is fetched, but the listing record is the
  primary capture so a run needs only its listing-page budget.
- **Bound expectations:** two listing pages at the 800 ms politeness delay ≈ a run under
  2 s of transfer; the worker's `SOURCE_ACQUISITION_TIMEOUT_MS=300000` leaves ample
  headroom.
- **Live observation (2026-10-22), first real collection — 24 postings, run SUCCEEDED
  (3.98 s):** `jobsDiscovered` 24, `jobsAccepted` 24, 0 duplicates, 0 rejected, 0 parse
  failures, 0 HTTP failures; source health HEALTHY. Observed field yield: `title` and
  `company` present on all 24 (real employers, e.g. Radisson Blu), `state` classified into
  ADDIS_ABABA / ETHIOPIA_REGION, `date_published` parsed, description quality SUFFICIENT,
  employment type FULL_TIME where the description states it and UNKNOWN otherwise, salary
  UNKNOWN (no structured salary), application target UNKNOWN on the sample postings (their
  descriptions carry no in-text email/URL; ATS postings have no text evidence — see the
  deferred structured-field wiring above). Matcher scored all 24; no notification was
  reserved because the eligibility gates (minScore 60, minConfidence 45) were not both met —
  the highest scores were 72/confidence 33 and 50/confidence 47.
- **Operational note:** on a host that reaches the internet only through an HTTP proxy,
  Node's `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY` unless the worker is started with
  `NODE_USE_ENV_PROXY=1`. Without it every acquisition fails with `TypeError: fetch failed`
  (DNS unavailable directly); with it both sources collect normally.
