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
 * EffoySira (effoysira.com) — the first production source adapter (SRS §7.2, Appendix E;
 * approval record `docs/sources/effoysira.md`, ADR-0004).
 *
 * Access mechanism: STATIC_HTML. The site's robots.txt allows listing and post pages and
 * disallows `/wp-json/` (the WordPress REST API), which this adapter therefore never calls.
 * There is no RSS feed (`/feed/` serves HTML, verified twice on 2026-10-17), so discovery
 * walks the paginated category listing and then each post page.
 *
 * Markup relied on (WordPress "Blocksy" theme, verified against live HTML 2026-10-17; if the
 * theme changes, these are the strings to re-check):
 *   listing: `<h2 class="entry-title"><a href="https://effoysira.com/<slug>/" rel="bookmark">`
 *   post:    `<h1 class="page-title">…</h1>`, `<div class="entry-content …">…</div>`, and
 *            `<meta property="article:published_time" content="ISO">` in the head.
 *
 * ponytail: no HTML-parser dependency — link extraction is one regex, content extraction is
 * a balanced-`<div>` counter, entity decoding is a small table. If the theme drifts, only
 * these helpers change; the adapter interface does not.
 */

const BASE = 'https://effoysira.com';

const USER_AGENT = 'JobHunter/1.0 (personal job matcher; polite crawler)';

export function createEffoySiraAdapter(
  config: SourceAdapterConfig,
  deps: {
    /** Injectable for tests; production uses the global fetch. */
    fetchImpl?: typeof fetch;
    /** Injectable no-op for tests. */
    delay?: (ms: number) => Promise<void>;
  } = {},
): JobSourceAdapter {
  // Adapter knobs live in the approved registration's `options` (opaque to the pipeline);
  // anything absent falls back to the defaults below.
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

  /** Decode the handful of entities WordPress emits, then strip tags. */
  function extractText(html: string): string {
    return html
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#8217;|&#8216;/g, "'")
      .replace(/&#8220;|&#8221;/g, '"')
      .replace(/&nbsp;/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractTitle(html: string): string | null {
    const m = /<h1 class="page-title"[^>]*>([^<]+)<\/h1>/i.exec(html);
    return m ? extractText(m[1]) : null;
  }

  function extractPublishedTime(html: string): string | null {
    const m = /<meta property="article:published_time" content="([^"]+)"/.exec(html);
    return m ? m[1] : null;
  }

  /**
   * Raw HTML of the post content block. `<div class="entry-content …">` is matched with a
   * depth counter so nested `<div>`s (ad blocks, telegram widget) do not truncate it, and
   * the *longest* block wins: the theme renders extra `entry-content` containers (ad
   * slots) before the article, and picking the first one once yielded a 50-character ad
   * script as the whole description. Returns the un-stripped block: `collect` takes the
   * plain text for `rawDescription` and matches field patterns on paragraph boundaries.
   */
  function extractContent(html: string): string | null {
    // Ad scripts are not content and their bodies break the div-balance walk, so they
    // go before any counting or text extraction.
    const clean = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    let best: string | null = null;
    let from = 0;
    for (;;) {
      const start = clean.indexOf('<div class="entry-content', from);
      if (start === -1) break;
      from = start + 1;
      const open = clean.indexOf('>', start);
      if (open === -1) break;
      let depth = 1;
      let pos = open + 1;
      while (pos < clean.length && depth > 0) {
        const nextOpen = clean.indexOf('<div', pos);
        const nextClose = clean.indexOf('</div>', pos);
        if (nextClose === -1) {
          depth = -1;
          break;
        }
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++;
          pos = nextOpen + 4;
        } else {
          depth--;
          pos = nextClose + 6;
        }
      }
      if (depth !== 0) continue;
      const block = clean.slice(open + 1, pos - 6);
      if (best === null || block.length > best.length) best = block;
    }
    return best;
  }

  /**
   * Field lines such as `Location:` live in their own `<p>`/`<h4>` blocks; split the
   * content block on paragraph boundaries so a field cannot swallow the paragraphs
   * that follow it, then match the pattern within one paragraph of text. The capture
   * stops at a sentence end, keeping the rest of the paragraph out of the evidence.
   */
  function extractFieldLine(blockHtml: string, re: RegExp): string | null {
    for (const segment of blockHtml.split(/<\/p>|<br[^>]*>|<\/h[1-6]>/i)) {
      const line = extractText(segment);
      const m = re.exec(line);
      if (m) return m[1].trim();
    }
    return null;
  }

  const LOCATION_LINE = /(?:Location|Place of Work)\s*:\s*([^.!?]+)/i;
  const SALARY_LINE = /Salary[^.!?]{0,40}?:\s*([^.!?]+)/i;

  /** `Location:` / `Place of Work:` lines inside the content are the location evidence. */
  function extractLocation(blockHtml: string): string | null {
    return extractFieldLine(blockHtml, LOCATION_LINE);
  }

  /** The first salary line, when the announcement states one. */
  function extractSalaryText(blockHtml: string): string | null {
    return extractFieldLine(blockHtml, SALARY_LINE);
  }

  function countPostLinks(html: string): number {
    const re = /<h2 class="entry-title"><a href="https:\/\/effoysira\.com\/[^"]+"/g;
    let count = 0;
    while (re.exec(html) !== null) count++;
    return count;
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

  // ── port implementation ─────────────────────────────────────────────────────

  async function collect(context: CollectionContext): Promise<RawJobEvidence[]> {
    const { signal, now } = context;
    const evidence: RawJobEvidence[] = [];

    // Discover post URLs from the category listing. Only recent pages are read per run;
    // the schedule governs freshness and the pipeline's dedupe makes re-observation free.
    const postUrls: string[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= maxListingPages; page++) {
      if (signal?.aborted) break;
      const url =
        page === 1 ? `${BASE}/category/job/` : `${BASE}/category/job/page/${page}/`;
      const html = await get(url, signal);
      if (html === null) break;
      const re = /<h2 class="entry-title"><a href="(https:\/\/effoysira\.com\/[^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        if (!seen.has(m[1])) {
          seen.add(m[1]);
          postUrls.push(m[1]);
        }
      }
      if (page < maxListingPages) await delay(delayMs);
    }

    for (const postUrl of postUrls) {
      if (signal?.aborted) break;
      const html = await get(postUrl, signal);
      if (html === null) continue;

      const title = extractTitle(html);
      const contentHtml = extractContent(html);
      const publishedTime = extractPublishedTime(html);
      const locationLine = contentHtml === null ? null : extractLocation(contentHtml);
      const salaryLine = contentHtml === null ? null : extractSalaryText(contentHtml);
      // The description is the block's text; fields are matched on paragraph boundaries
      // before this collapse, so one field cannot swallow the paragraphs after it.
      const content = contentHtml === null ? null : extractText(contentHtml);

      evidence.push({
        // No external id exists (record: identifier none); identity is the canonical URL.
        sourceJobIdentifier: null,
        sourceUrl: postUrl,
        rawTitle: title,
        // Company text exists in the title and tags but is not a structured field;
        // extraction would be a heuristic, so it stays null (UNKNOWN) rather than guessed.
        rawCompany: null,
        rawLocation: locationLine,
        rawDescription: content,
        // `article:published_time` is an ISO timestamp; the shared gregorian normalizer
        // parses ISO directly (GREGORIAN_ISO_V1).
        rawPublishedDateText: publishedTime,
        rawSalaryText: salaryLine,
        // The full HTML is deliberately not retained: template noise (ads, scripts) changes
        // constantly and would defeat content dedupe. The extracted text is the evidence.
        rawPayload: null,
        collectedAt: publishedTime === null ? now : new Date(publishedTime),
      });

      await delay(delayMs);
    }

    return evidence;
  }

  async function normalize(raw: RawJobEvidence): Promise<NormalizedJob> {
    return normalizeRawEvidence(raw, {
      declaredCalendar: config.declaredCalendar,
      declaredDateFormat: config.declaredDateFormat,
    });
  }

  async function healthCheck(context: HealthCheckContext): Promise<HealthResult> {
    let html: string | null;
    try {
      html = await get(`${BASE}/category/job/`, context.signal);
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
    const sampleSize = countPostLinks(html);
    return {
      status: sampleSize > 0 ? HealthStatus.HEALTHY : HealthStatus.DEGRADED,
      checkedAt: context.now,
      sampleSize,
      detail: sampleSize > 0 ? null : 'no post links found on the listing page',
    };
  }

  return { config, collect, normalize, healthCheck };
}
