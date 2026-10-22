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
 * JobWebEthiopia (jobwebethiopia.com) — the third production source adapter (SRS §7.2,
 * Appendix E; approval record `docs/sources/jobwebethiopia.md`, ADR-0004).
 *
 * Access mechanism: STATIC_HTML. robots.txt (verified 2026-10-22) is exactly
 * `User-agent: *` / `Crawl-delay: 30` — every path is allowed, and the requested 30 s
 * spacing is what `delayMs` defaults to. There is no terms-of-service page (only a privacy
 * policy); the product owner reviewed the site and approved the source on 2026-10-22.
 *
 * Discovery walks the paginated `/jobs/` listing and then each posting page, because the
 * listing carries only an excerpt and no application details. Markup relied on (verified
 * against live HTML 2026-10-22; if the theme changes, these are the strings to re-check):
 *   listing: `<div id="titlo"><strong><a href="…/jobs/<slug>/">Title</a></strong>`
 *   post:    `<h1 class="title">…</h1>`, `<div class="date"><strong>16 Oct 2026</strong>`,
 *            `<li id="topss"><b>Company|Location|State|Job type|Job category:</b> …</li>`,
 *            `<div class="job-detail-description…">…</div>`, and
 *            `<h1 class="how-to-apply">Method of Application</h1><font …>…</font>`.
 *
 * Budget: `Crawl-delay` forces one request per 30 s, so a run is bounded to one listing page
 * plus `maxPosts` posting pages (~190 s for the default six). The per-source schedule, not
 * the page budget, governs freshness; re-observation is free downstream.
 *
 * ponytail: no HTML-parser dependency — link extraction is one regex and the description
 * block is a balanced-`<div>` walk, both shared in shape with the EffoySira adapter. If the
 * theme is replaced, only these helpers change; the adapter interface does not.
 */

const BASE = 'https://jobwebethiopia.com';

const USER_AGENT = 'JobHunter/1.0 (personal job matcher; polite crawler)';

export function createJobWebEthiopiaAdapter(
  config: SourceAdapterConfig,
  deps: {
    /** Injectable for tests; production uses the global fetch. */
    fetchImpl?: typeof fetch;
    /** Injectable no-op for tests. */
    delay?: (ms: number) => Promise<void>;
  } = {},
): JobSourceAdapter {
  // Adapter knobs live in the approved registration's `options` (opaque to the pipeline).
  const delayMs =
    typeof config.options.delayMs === 'number' && config.options.delayMs >= 0
      ? config.options.delayMs
      : 30_000;
  const maxListingPages =
    typeof config.options.maxListingPages === 'number' &&
    Number.isInteger(config.options.maxListingPages) &&
    config.options.maxListingPages >= 1
      ? config.options.maxListingPages
      : 1;
  const maxPosts =
    typeof config.options.maxPosts === 'number' &&
    Number.isInteger(config.options.maxPosts) &&
    config.options.maxPosts >= 1
      ? config.options.maxPosts
      : 6;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** Ad scripts are not content and their bodies break the div-balance walk. */
  function stripNoise(html: string): string {
    return html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  }

  /** Decode the entities WordPress emits, then strip tags, leaving plain text. */
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

  /**
   * The site publishes application emails through Cloudflare's email obfuscation
   * (`<span class="__cf_email__" data-cfemail="hex">[email protected]</span>`), which the
   * site's own script decodes in the reader's browser. This is that same deterministic
   * decode — every byte is XORed with the first — so the captured text carries the address
   * the publisher shows a human, not a placeholder.
   */
  function decodeObfuscatedEmails(html: string): { html: string; decoded: number } {
    let decoded = 0;
    const replaced = html.replace(
      /<span class="__cf_email__" data-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/span>/gi,
      (whole: string, hex: string) => {
        if (hex.length < 4 || hex.length % 2 !== 0) return whole;
        const key = Number.parseInt(hex.slice(0, 2), 16);
        let address = '';
        for (let i = 2; i < hex.length; i += 2) {
          address += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16) ^ key);
        }
        decoded += 1;
        return address;
      },
    );
    return { html: replaced, decoded };
  }

  /**
   * Raw HTML of the `class="<marker>…"` block, matched with a depth counter so nested
   * `<div>`s do not truncate it. The longest match wins: the theme wraps the article in an
   * outer container of the same class prefix.
   */
  function extractDivBlock(html: string, marker: string): string | null {
    let best: string | null = null;
    let from = 0;
    const open = `<div class="${marker}`;
    for (;;) {
      const start = html.indexOf(open, from);
      if (start === -1) break;
      from = start + 1;
      const blockOpen = html.indexOf('>', start);
      if (blockOpen === -1) break;
      let depth = 1;
      let pos = blockOpen + 1;
      while (pos < html.length && depth > 0) {
        const nextOpen = html.indexOf('<div', pos);
        const nextClose = html.indexOf('</div>', pos);
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
      const block = html.slice(blockOpen + 1, pos - 6);
      if (best === null || block.length > best.length) best = block;
    }
    return best;
  }

  /** A `<li><b>Label:</b> …</li>` field of the posting header, as plain text. */
  function listField(html: string, label: string): string | null {
    const re = new RegExp(`<b>\\s*${label}\\s*:?\\s*</b>([\\s\\S]*?)</li>`, 'i');
    const match = re.exec(html);
    if (match === null) return null;
    const text = extractText(match[1]);
    return text === '' ? null : text;
  }

  function extractTitle(html: string): string | null {
    const match = /<h1 class="title">([\s\S]*?)<\/h1>/i.exec(html);
    if (match === null) return null;
    const text = extractText(match[1]);
    return text === '' ? null : text;
  }

  function extractPublishedDateText(html: string): string | null {
    const match = /<div class="date">\s*<strong>([^<]+)<\/strong>/i.exec(html);
    if (match === null) return null;
    const text = match[1].trim();
    return text === '' ? null : text;
  }

  /** The posting's own "Method of Application" section, as raw HTML. */
  function extractApplicationSection(html: string): string | null {
    const match =
      /<h1 class="how-to-apply">\s*Method of Application\s*<\/h1>([\s\S]*?)(?:<HR|<div id="apply_form")/i.exec(
        html,
      );
    return match === null ? null : match[1];
  }

  /**
   * Field lines such as `Salary:` sit in their own `<li>`/`<p>` block; split on block
   * boundaries so one field cannot swallow the paragraphs after it, then match within a
   * single line. The capture stops at a sentence end.
   */
  const SALARY_LINE = /Salary[^.!?]{0,40}?[.:]\s*([^.!?]+)/i;

  function extractSalaryText(blockHtml: string): string | null {
    for (const segment of blockHtml.split(/<\/p>|<\/li>|<br[^>]*>/i)) {
      const line = extractText(segment);
      const match = SALARY_LINE.exec(line);
      if (match) return match[1].trim();
    }
    return null;
  }

  function listingUrl(page: number): string {
    return page === 1 ? `${BASE}/jobs/` : `${BASE}/jobs/page/${page}/`;
  }

  const CARD_LINK = /<div id="titlo">\s*<strong><a href="([^"]+)">([\s\S]*?)<\/a>/gi;

  function countCards(html: string): number {
    const seen = new Set<string>();
    const re = new RegExp(CARD_LINK.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) seen.add(match[1]);
    return seen.size;
  }

  // ── HTTP (polite: fixed UA, 30 s between requests, abort-aware) ─────────────

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

    // Every request after the first waits `delayMs`, which is the site's Crawl-delay.
    let requests = 0;
    async function politeGet(url: string): Promise<string | null> {
      if (requests > 0) await delay(delayMs);
      requests += 1;
      return get(url, signal);
    }

    // Discovery: newest postings first; the budget bounds the run, dedupe is downstream.
    const cards: Array<{ url: string; title: string }> = [];
    const seen = new Set<string>();
    for (let page = 1; page <= maxListingPages && cards.length < maxPosts; page++) {
      if (signal?.aborted) break;
      const html = await politeGet(listingUrl(page));
      if (html === null) break;
      const re = new RegExp(CARD_LINK.source, 'gi');
      let match: RegExpExecArray | null;
      while ((match = re.exec(html)) !== null && cards.length < maxPosts) {
        const url = match[1];
        if (seen.has(url)) continue;
        seen.add(url);
        cards.push({ url, title: extractText(match[2]) });
      }
    }

    for (const card of cards) {
      if (signal?.aborted) break;
      const html = await politeGet(card.url);
      // A posting page that cannot be read yields no record: the listing excerpt is a
      // truncated preview, not a description, and inventing one would be fabrication.
      if (html === null) continue;

      const decode = decodeObfuscatedEmails(stripNoise(html));
      const page = decode.html;
      const title = extractTitle(page) ?? (card.title === '' ? null : card.title);
      const descriptionBlock = extractDivBlock(page, 'job-detail-description');
      const descriptionText = descriptionBlock === null ? null : extractText(descriptionBlock);
      const applicationSection = extractApplicationSection(page);
      const applicationText = applicationSection === null ? null : extractText(applicationSection);

      // The posting body as the reader sees it: description, then the application section
      // under the heading the page gives it. Both are source text; the application-target
      // and employment normalizers read them together.
      const rawDescription =
        [descriptionText, applicationText === null ? null : `Method of Application ${applicationText}`]
          .filter((part): part is string => part !== null && part !== '')
          .join('\n\n') || null;

      const locationText = listField(page, 'Location');
      const stateText = listField(page, 'State');

      evidence.push({
        // The permalink slug is derived from the title, not published as an id: identity is
        // the canonical URL (record: identifier none).
        sourceJobIdentifier: null,
        sourceUrl: card.url,
        rawTitle: title,
        rawCompany: listField(page, 'Company'),
        // `State:` names the region ("Addis Ababa Jobs", "Oromia Jobs") and classifies;
        // `Location:` is the generic country label ("Ethiopia"), so it is the fallback only.
        rawLocation: stateText ?? locationText,
        rawDescription,
        // The page states `16 Oct 2026` (a named month, parsed by the shared normalizer).
        // The listing's `16/Oct/2026` numeric form is ambiguous to the parser and is not used.
        rawPublishedDateText: extractPublishedDateText(page),
        rawSalaryText: descriptionBlock === null ? null : extractSalaryText(descriptionBlock),
        // Structured header fields the publisher declares, preserved verbatim for a later
        // policy change (same convention as the Ethiojobs adapter). Nothing below is
        // normalized: employment type is still mined from the description text.
        rawPayload: {
          jobType: listField(page, 'Job type'),
          category: listField(page, 'Job category'),
          locationText,
          stateText,
          // How many Cloudflare-obfuscated addresses this page's text carried (0 when the
          // posting publishes none): a count, not an assumption that a decode happened.
          cloudflareEmailsDecoded: decode.decoded,
        },
        // The page states a published date, not a collection time; the observation time is
        // the collection.
        collectedAt: now,
      });
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
    const sampleSize = countCards(html);
    return {
      status: sampleSize > 0 ? HealthStatus.HEALTHY : HealthStatus.DEGRADED,
      checkedAt: context.now,
      sampleSize,
      detail: sampleSize > 0 ? null : 'no job cards found on the listing page',
    };
  }

  return { config, collect, normalize, healthCheck };
}
