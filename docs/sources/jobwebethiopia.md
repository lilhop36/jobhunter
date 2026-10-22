# Source approval record: JobWebEthiopia

- **Source:** JobWebEthiopia
- **Status:** APPROVED
- **Access mechanism:** STATIC_HTML
- **Robots and terms review:** robots.txt (fetched 2026-10-22) is exactly `User-agent: *` / `Crawl-delay: 30`: every path is allowed and the site asks for one request per 30 seconds, which the adapter honours (`delayMs` 30000 between every request). There is no terms-of-service page on the site — only a Privacy Policy — so there is no clause to read against; the product owner reviewed the site's robots policy and Privacy Policy on 2026-10-22 and approved the source ("Approve JobWebEthiopia"). No login, form submission or REST endpoint is used.
- **Stable job identifier field:** none is published; a posting's permalink `/jobs/<slug>/` is derived from its title, so the adapter captures no `sourceJobIdentifier` and identity is the canonical URL (ADR-0001 concept 1), verified stable for the same posting on 2026-10-22
- **Declared calendar:** GREGORIAN
- **Declared currency:** none (no salary field; an in-text `Salary:` line is the only evidence)
- **Canonical URL identity trusted:** yes
- **Expected results:** RESULTS_EXPECTED
- **Reviewed by:** product owner
- **Review date:** 2026-10-22

## Decision rationale

JobWebEthiopia (jobwebethiopia.com) is a national Ethiopian job board publishing a few
dozen postings a day ("Today: 1629 Jobs", 126 listing pages, 11 cards per page on
2026-10-22). It is server-rendered WordPress: the listing and every posting page are plain
HTML, so the adapter needs no browser and no JavaScript. Listing cards carry only an
excerpt, so the adapter fetches each posting page for the description and the application
path — the two fields the matcher and the notification depend on.

## Notes

- **Discovery:** `/jobs/`, then `/jobs/page/N/`. Newest first; the run budget is one listing
  page, which is the publisher's own politeness requirement (see below).
- **Politeness budget:** `Crawl-delay: 30` is applied between *every* request, not between
  listing pages only. With the default `maxPosts` six, a run makes seven requests and waits
  six times (≈180 s of waiting plus transfer), which fits the worker's
  `SOURCE_ACQUISITION_TIMEOUT_MS=300000`. Raising `maxPosts` without also raising that bound
  would let the acquisition bound cut a run short, so the two are changed together.
- **Freshness comes from the schedule, not the page budget:** a run reads only the newest
  six postings, so this source is seeded on a shorter interval (`3h`) than the two larger
  boards. Re-observation of a posting is free downstream (raw-job dedupe).
- **Fields observed live (2026-10-22):** `<h1 class="title">` title, `<div class="date">`
  published date as `16 Oct 2026` (a named month, parsed by the shared Gregorian normalizer
  as `GREGORIAN_NAMED_MONTH_V1`), `Company:`, `Location: Ethiopia` (generic country),
  `State: "Addis Ababa Jobs"` / `"Oromia Jobs"` (region, classifies), `Job type:` text
  ("Full-Time"), `Job category:`, a full `job-detail-description` block, and a
  `Method of Application` section.
- **Capture decisions:**
  - `rawLocation` is `State:` where present and `Location:` otherwise: `State:` is the
    specific evidence ("Addis Ababa Jobs" → ADDIS_ABABA, "Oromia Jobs" →
    ETHIOPIA_REGION), while `Location:` reads only "Ethiopia", which classifies UNKNOWN.
  - The listing's date form `16/Oct/2026` is ambiguous to the shared date normalizer (it is
    not one of the declared numeric formats and is not a named-month form), so it is not
    used; the posting page's `16 Oct 2026` is the published-date evidence. Both state the
    same day.
  - `rawDescription` is the description block text followed by the posting's
    `Method of Application` text under that heading — both are the posting's own body text
    as a reader sees it, and the shared employment/application/description-quality
    normalizers read them together.
  - Application emails are published through Cloudflare email obfuscation
    (`<span class="__cf_email__" data-cfemail="…">`), which the site's own script decodes in
    the reader's browser. The adapter performs that same deterministic decode (each byte
    XOR the first), so the captured text carries the address the publisher shows a human
    instead of a placeholder. `rawPayload.cloudflareEmailsDecoded` records how many
    addresses that decode actually produced (0 when the posting publishes none).
- **What stays UNKNOWN by capture (honest limits, not inferred):**
  - Deadline: the site publishes no expiry field. Postings say things like "within 7
    working days from the date of this announcement"; that is prose, not a date, so it is
    not converted into one.
  - Salary: `Salary:` is a bullet inside the description, not a field, and is frequently
    "Negotiable"; `rawSalaryText` carries exactly that text.
  - Employment type as a *field*: `Job type:` is captured verbatim in `rawPayload`, but the
    matcher still reads employment type from the description text via the shared
    `EMPLOYMENT_TYPE_V1` classifier (wiring the structured value is a separate,
    sign-off-gated policy change, as with Ethiojobs).
  - Postings that are only an image or carry no description text: the shared
    description-quality classifier decides, and a record that is not matchable stays
    non-matchable rather than being padded.
- **Failure behaviour:** a posting page that cannot be read yields no record for that
  posting (the listing excerpt is a truncated preview, not a description). The run's
  counters therefore show it as never discovered, and the next run reads it again.
- **Health check:** counts listing cards on `/jobs/`; HEALTHY with cards, DEGRADED with a
  readable page holding none, FAILING when the page is unreachable or errors.
- **Operational note:** on a host that reaches the internet only through an HTTP proxy, the
  worker must run with `NODE_USE_ENV_PROXY=1` for `fetch` to use `HTTP_PROXY`; without it
  every acquisition fails with `TypeError: fetch failed` (as documented for EffoySira).
- **Live observation (2026-10-22), first real collection — 6 postings, run SUCCEEDED
  (219 s):** `jobsDiscovered` 6, `jobsAccepted` 6, 0 duplicates, 0 rejected, 0 parse
  failures, 0 HTTP failures; source health HEALTHY. Observed field yield: title and company
  on all six (e.g. "MeQrez Health Services", "Ahadu Bank S.C", "TM Law firm"), `State:`
  classified ADDIS_ABABA, published date parsed from `16 Oct 2026`, description quality
  SUFFICIENT on all six, employment type FULL_TIME where the text states it and UNKNOWN
  otherwise, salary NEGOTIABLE where a `Salary: Negotiable` bullet exists and UNKNOWN
  otherwise, application path EMAIL with the decoded address (`jobs@mytmlawfirm.com`) on the
  two postings that publish one and ONLINE_URL where the posting links to a form. Matcher
  scored all six; no notification was reserved because the eligibility gates (minScore 60,
  minConfidence 45) were not both met — the highest scores were 75/confidence 38 (score
  passes, confidence does not) and 50/confidence 47 (confidence passes, score does not).
- **Operational note:** a run spends most of its time waiting (six 30 s gaps), so its
  duration is expected to be ~3.5–4 minutes; that is the crawl delay working, not a stall.
