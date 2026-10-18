# Source approval record: EffoySira

- **Source:** EffoySira
- **Status:** APPROVED
- **Access mechanism:** STATIC_HTML
- **Robots and terms review:** robots.txt (2026-10-17) allows crawling of listing and post pages and disallows `/wp-json/`, search paths (`/?s=`, `/search/`); the adapter must therefore never use the WordPress REST API. The RSS feed (`/feed/`, `/category/job/feed/`) was checked twice and serves HTML, not XML, so it is unavailable. Terms and Conditions contain a performance clause ("not use the website in a way that may impair the performance") - the adapter respects it with a polite user agent, delays between requests, and a bounded page budget per run. The reproduction clause ("The reproduction, distribution in any method whether online or offline is strictly not prohibited") is treated as a typographical error for "strictly prohibited", i.e. reproduction with attribution is permitted; verdict allowed. Reviewed 2026-10-17 by the product owner.
- **Stable job identifier field:** none
- **Declared calendar:** GREGORIAN
- **Declared currency:** none
- **Canonical URL identity trusted:** yes
- **Expected results:** RESULTS_EXPECTED
- **Reviewed by:** product owner
- **Review date:** 2026-10-17

## Decision rationale

EffoySira (effoysira.com, "EffoyJobs") is an established Ethiopian job-vacancy posting site
operating from Addis Ababa, with a public posting archive (84 listing pages), a sitemap, and
a robots policy that explicitly permits crawling job content. The owner read the ambiguous
reproduction clause as a typographical error ("strictly not prohibited" -> permitted with
attribution) and accepts collection of posting content for personal job matching. The
site's own performance clause is honoured: the adapter rate-limits, caps pages per run, and
never touches the robots-disallowed REST API.

## Notes

- WordPress + Yoast. Posts are vacancy **announcements**: one post frequently contains
  **several positions** (e.g. the MSA Trading post holds four). The pipeline ingests one
  posting per record, so one announcement becomes one Job whose `title` is the announcement
  title, not a specific position title. Downstream matching must tolerate that.
- No structured fields. Company appears in the title and in post tags; location appears as
  free text in content (`Location:` / `Place of Work:`); deadline is free text
  (`Deadline: October 20, 2026`); salary is usually non-numeric ("Salary will be Company
  Salary Scale"); the application target is an email address inside the content.
- Dates are Gregorian with English month names; the source declares no currency (amounts,
  when present, appear as plain numbers or "birr" inside text).
- Post URLs are stable per-posting slugs (`/<slug>/`, e.g.
  `dema-hope-real-estate-vacancy-2026-2/`); the trailing `-2` is WordPress slug dedupe and
  is stable once published. Verified against `post-sitemap.xml`. No external job id exists,
  so identity is the canonical URL (ADR-0001).
- Discovery: category listing pages (`/category/job/`, paginated `/page/N/`) for recency;
  `post-sitemap.xml` for backfill/completeness. Feeds were verified unavailable (`/feed/`
  and `/category/job/feed/` serve HTML, not XML).
- **Live observation (2026-10-17), first real collection — 18 postings, run SUCCEEDED:**
  post pages render an AdSense `entry-content` container *before* the article and ad
  `<script>` bodies *inside* the content, so the parser strips scripts/styles first and
  takes the longest `entry-content` block; script text must never reach `rawDescription`
  (a first-match version produced a 50-character ad script as the whole description and
  every field came out UNKNOWN — now a regression test).
- **Latency and bounds:** requests from the collection host took 4–5 s each, so a full run
  (2 listing pages + ~18 posts at the 800 ms politeness delay) takes ~50–70 s. The worker's
  `SOURCE_ACQUISITION_TIMEOUT_MS` must exceed that with headroom; `300000` with
  `SOURCE_STALE_RUN_SECONDS=900` was observed working. A transient connection failure
  (~1 request in several from this network) fails the whole acquisition: the run is FAILED,
  health FAILING, and the next scheduled or manual run recovers.
- **Observed field yield (18 postings):** locations resolved (ADDIS_ABABA, ETHIOPIA_CITY),
  application targets resolved (EMAIL, ONLINE_URL, IN_PERSON), salary mostly non-numeric
  (AS_PER_SCALE/NEGOTIABLE, one EXACT/ETB), description quality SUFFICIENT on all 18.
