import { HealthStatus } from '@domain/enums';
import type {
  CollectionContext,
  HealthCheckContext,
  JobSourceAdapter,
  SourceAdapterConfig,
} from '@ports/source-adapter';
import type { HealthResult, NormalizedJob, RawJobEvidence } from '@domain/types';
import { normalizeRawEvidence } from './normalize-evidence';

/**
 * Ethiojobs (ethiojobs.net) — the second production source adapter (SRS 7.2, Appendix E;
 * approval record `docs/sources/ethiojobs.md`, ADR-0004).
 *
 * Access mechanism: STATIC_HTML. robots.txt (verified 2026-10-22) allows listing and job
 * pages and disallows `/auth/*`, `/api/*`, `/users/*`, `/companies/functions*` — this
 * adapter reads only `/jobs?page=N` listings.
 *
 * The site is a Next.js application: every listing page embeds the complete structured
 * record for its twelve entries inside `<script id="__NEXT_DATA__" …>`, so one listing
 * request yields everything the pipeline consumes — title, description HTML, region,
 * published/expiry dates, company, application method — without per-post fetches.
 * Page 1 embeds `props.pageProps.jobs` as an array, page N as `{ data, meta }`; both are
 * accepted (verified live 2026-10-22).
 *
 * ponytail: no HTML-parser dependency — the JSON blob is lifted with a single regex and
 * parsed; text extraction is the same entity-and-tags strip the EffoySira adapter carries.
 * If the site leaves Next.js, only these helpers change.
 */

const BASE = 'https://ethiojobs.net';

const USER_AGENT = 'JobHunter/1.0 (personal job matcher; polite crawler)';

export function createEthiojobsAdapter(
  config: SourceAdapterConfig,
  deps: {
    /** Injectable for tests; production uses the global fetch. */
    fetchImpl?: typeof fetch;
    /** Injectable no-op for tests. */
    delay?: (ms: number) => Promise<void>;
  } = {},
): JobSourceAdapter {
  const delayMs =
    typeof config.options.delayMs === 'number' && config.options.delayMs >= 0
      ? config.options.delayMs
      : 800;
  const maxListingPages =
    typeof config.options.maxListingPages === 'number' &&
    Number.isInteger(config.options.maxListingPages) &&
    config.options.maxListingPages >= 1
      ? config.options.maxListingPages
      : 2;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // ── parsing helpers (fixture-tested; see the header note) ──────────────────

  /** Decode the entities the site emits and strip tags, leaving plain text. */
  function extractText(html: string): string {
    return html
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  type ListingEntry = Record<string, unknown>;

  function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  /**
   * The structured `__NEXT_DATA__` payload of a listing page, or null when the page
   * carries none (shell/loading state) or malformed JSON.
   */
  function extractListingEntries(html: string): ListingEntry[] | null {
    const match =
      /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/i.exec(
        html,
      );
    if (match === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]) as unknown;
    } catch {
      return null;
    }
    // `jobs` is an array on page 1 and `{ data: [...] }` on page N (live-verified).
    const props = (parsed as { props?: { pageProps?: { jobs?: unknown } } }).props;
    const jobs = props?.pageProps?.jobs;
    const entries =
      Array.isArray(jobs) ? jobs : Array.isArray((jobs as { data?: unknown })?.data)
        ? ((jobs as { data: unknown[] }).data as ListingEntry[])
        : null;
    return entries;
  }

  /**
   * A salary line inside the description text, when the posting states one
   * ("Salary: Negotiable", "Salary. 15,000 birr"). The capture stops at a sentence
   * end so the rest of the paragraph stays out of the evidence.
   */
  const SALARY_LINE = /Salary[^.!?]{0,40}?[.:]\s*([^.!?]+)/i;

  function extractSalaryLine(descriptionHtml: string): string | null {
    for (const segment of descriptionHtml.split(/<\/p>|<br[^>]*>/i)) {
      const line = extractText(segment);
      const match = SALARY_LINE.exec(line);
      if (match) return match[1].trim();
    }
    return null;
  }

  // ── HTTP (polite: fixed UA, delay between requests, abort-aware) ────────────

  async function get(url: string, signal?: AbortSignal): Promise<string | null> {
    const res = await fetchImpl(url, {
      signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return null;
    return res.text();
  }

  function listingUrl(page: number): string {
    return page === 1 ? `${BASE}/jobs` : `${BASE}/jobs?page=${page}`;
  }

  // ── port implementation ─────────────────────────────────────────────────────

  async function collect(context: CollectionContext): Promise<RawJobEvidence[]> {
    const { signal, now } = context;
    const evidence: RawJobEvidence[] = [];

    // The listing serves the newest postings first; pages per run are the budget, the
    // schedule governs freshness, and the raw store's identifier dedupe makes
    // re-observation free.
    const seen = new Set<string>();
    for (let page = 1; page <= maxListingPages; page++) {
      if (signal?.aborted) break;
      const html = await get(listingUrl(page), signal);
      if (html === null) break;
      const entries = extractListingEntries(html);
      if (entries === null) break;

      for (const entry of entries) {
        const slug = asString(entry.slug);
        const title = asString(entry.title);
        if (slug === null || title === null || seen.has(slug)) continue;
        seen.add(slug);

        const descriptionHtml = asString(entry.description);
        const company = entry.company as { name?: unknown; email?: unknown } | null | undefined;

        evidence.push({
          // The slug's leading id segment is the site's stable external identifier
          // (record: identifier field = posting slug).
          sourceJobIdentifier: slug,
          sourceUrl: `${BASE}/job/${slug}`,
          rawTitle: title,
          rawCompany: company === null || company === undefined ? null : asString(company.name),
          rawLocation: asString(entry.state),
          // The description HTML is reduced to text so the shared text-based
          // normalizers (application target, description quality) read rows as usual.
          rawDescription: descriptionHtml === null ? null : extractText(descriptionHtml),
          rawPublishedDateText: asString(entry.date_published),
          rawSalaryText:
            descriptionHtml === null ? null : extractSalaryLine(descriptionHtml),
          // Structured fields the publisher itself declares, preserved verbatim for a
          // later application-target/matching policy change (owner decision
          // 2026-10-22). Nothing below is normalized yet — see the approval record.
          rawPayload: {
            applicationMethod: entry.application_method ?? null,
            applicationEmail: entry.application_email ?? null,
            applicationForm: entry.application_form ?? null,
            careerPageLink: entry.career_page_link ?? null,
            dateExpiry: entry.date_expiry ?? null,
            careerLevel: entry.level ?? null,
            locationType: entry.location_type ?? null,
            employmentTypeCode: entry.type ?? null,
            categories: Array.isArray(entry.catalogs)
              ? (entry.catalogs as unknown[]).map((catalog) =>
                  typeof catalog === 'string'
                    ? catalog
                    : asString((catalog as { name?: unknown })?.name),
                )
              : null,
            companyEmail:
              company === null || company === undefined ? null : (asString(company.email) ?? null),
            opaqueInternalId: entry.id ?? null,
          },
          collectedAt: now,
        });
      }
      if (page < maxListingPages) await delay(delayMs);
    }

    return evidence;
  }

  async function normalize(raw: RawJobEvidence): Promise<NormalizedJob> {
    return normalizeRawEvidence(raw, {
      declaredCalendar: config.declaredCalendar,
      declaredDateFormat: config.declaredDateFormat,
    });
  }

  function countEntries(html: string): number {
    const entries = extractListingEntries(html);
    if (entries === null) return 0;
    return entries.filter((entry) => asString(entry.slug) !== null && asString(entry.title) !== null)
      .length;
  }

  async function healthCheck(context: HealthCheckContext): Promise<HealthResult> {
    let html: string | null;
    try {
      html = await get(listingUrl(1), context.signal);
    } catch (error) {
      return {
        status: HealthStatus.FAILING,
        checkedAt: context.now,
        sampleSize: null,
        detail: error instanceof Error ? error.message : 'fetch failed',
      };
    }
    if (html === null) {
      return {
        status: HealthStatus.FAILING,
        checkedAt: context.now,
        sampleSize: null,
        detail: 'listing page unreachable',
      };
    }
    const sampleSize = countEntries(html);
    return {
      status: sampleSize > 0 ? HealthStatus.HEALTHY : HealthStatus.DEGRADED,
      checkedAt: context.now,
      sampleSize,
      detail: sampleSize > 0 ? null : 'no job entries found on the listing page',
    };
  }

  return { config, collect, normalize, healthCheck };
}
