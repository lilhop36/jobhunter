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
  - `application_method`/`application_email`/`career_page_link` are structured fields and are
    now mapped by the adapter itself (2026-10-23): `EMAIL` → `EMAIL` + `applyEmail`,
    `CAREER_PAGE_LINK` → `ONLINE_URL` + `applyUrl`, `BOTH` → the link (same precedence as
    the text extractor). Observed split of the 24 captured postings: 13 `EMAIL`, 5
    `CAREER_PAGE_LINK`, 5 `ATS`, 1 `BOTH`. `ATS` arrives with neither a link nor an email,
    so those 5 stay UNKNOWN — an honest "no usable path", not an invented one.
  - `date_expiry` is now parsed with the shared date parser and stored as
    `applicationDeadline` when no labelled description deadline outranks it (2026-10-23).
    A malformed declared value falls back to the description text instead of being trusted.
- **Structured capture (rawPayload):** the listing's structured non-text fields —
  `application_method`, `application_email`, `date_expiry`, `level`, `location_type`,
  `type`, category names, company email, opaque internal `id` — are preserved verbatim in
  `rawPayload` for debugging and reprocessing. Application method/email/link and expiry are
  read back by `normalize` through the adapter's own mapping (ENG-016); `level`,
  `location_type`, `type` and categories stay raw until the sign-off-gated matcher wiring
  (owner decision 2026-10-22).
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
  descriptions carry no in-text email/URL; the declared fields are read only since the
  2026-10-23 mapping change, so the next run updates those rows in place). Matcher scored
  all 24; no notification was reserved because the eligibility gates (minScore 60,
  minConfidence 45) were not both met —
  the highest scores were 72/confidence 33 and 50/confidence 47.
- **Operational note:** on a host that reaches the internet only through an HTTP proxy,
  Node's `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY` unless the worker is started with
  `NODE_USE_ENV_PROXY=1`. Without it every acquisition fails with `TypeError: fetch failed`
  (DNS unavailable directly); with it both sources collect normally.
