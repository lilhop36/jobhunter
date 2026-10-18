import { describe, expect, it } from 'vitest';
import { CalendarType, HealthStatus, SalaryType } from '@domain/enums';
import { silentWorkerLogger } from '@ports/worker-logger';
import type { SourceAdapterConfig } from '@ports/source-adapter';
import { canonicalizeUrl } from '@domain/normalizers/url-normalizer';
import { createEffoySiraAdapter } from '@infrastructure/adapters/effoysira';
import { makeFakeConfig } from '../support/fake-source-adapter';

/**
 * Unit tests for the EffoySira adapter against fixture HTML that mirrors the live
 * WordPress ("Blocksy") markup verified 2026-10-17 (see the adapter header). No network:
 * the adapter takes an injectable `fetchImpl`, so every test serves local strings.
 */

const NOW = new Date('2026-10-17T15:00:00Z');

function config(overrides: Partial<SourceAdapterConfig> = {}) {
  return makeFakeConfig({
    adapterType: 'EFFOYSIRA_STATIC_HTML',
    adapterVersion: '1.0.0',
    accessMechanism: 'STATIC_HTML',
    declaredCalendar: CalendarType.GREGORIAN,
    canonicalUrlIdentityTrusted: true,
    options: { delayMs: 0, maxListingPages: 2 },
    ...overrides,
  });
}

function listingPage(urls: string[]): string {
  return `<!doctype html><html><body>
<nav><a href="https://effoysira.com/category/job/">Jobs</a></nav>
<div class="entries">${urls
    .map(
      (url) =>
        `<article><h2 class="entry-title"><a href="${url}" rel="bookmark">Some Title</a></h2></article>`,
    )
    .join('\n')}</div>
</body></html>`;
}

function postPage(
  overrides: Partial<Record<'title' | 'published' | 'content' | 'location', string>> = {},
) {
  return `<!doctype html><html><head>
<meta property="article:published_time" content="${overrides.published ?? '2026-10-17T09:57:17+00:00'}" />
</head><body>
<h1 class="page-title">${overrides.title ?? 'MSA Trading Vacancy Fresh Graduates'}</h1>
<div class="entry-content is-layout-flow">
<p>MSA Trading PLC would like to recruit professionals.</p>
<div class="code-block"><script>track('x');</script></div>
<h4>Position 1: Junior Officer</h4>
<p>Location: ${overrides.location ?? 'Addis Ababa'}</p>
<p>Salary: 15,000 birr</p>
<p>How to Apply: send your CV to hr@example.com before the deadline.</p>
${overrides.content ?? ''}
</div>
<div class="entry-tags">tags</div>
</body></html>`;
}

function fetchRouter(routes: Record<string, string | number>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const route = routes[url];
    if (typeof route === 'number') return new Response('', { status: route });
    if (route === undefined) return new Response('not found', { status: 404 });
    return new Response(route, { status: 200 });
  }) as unknown as typeof fetch;
}

const POST_1 = 'https://effoysira.com/msa-trading-vacancy-fresh-graduates/';
const POST_2 = 'https://effoysira.com/addis-bank-job-vacancy-2026/';

function makeRoutes(): Record<string, string | number> {
  const post = postPage();
  return {
    'https://effoysira.com/category/job/': listingPage([POST_1, POST_2]),
    'https://effoysira.com/category/job/page/2/': listingPage([POST_2, POST_1]),
    [POST_1]: post,
    [POST_2]: post,
  };
}

function context(overrides: { signal?: AbortSignal } = {}) {
  return {
    sourceRunId: '00000000-0000-0000-0000-0000000000aa',
    now: NOW,
    logger: silentWorkerLogger,
    ...overrides,
  };
}

describe('EffoySira adapter — collect (fixture HTML, no network)', () => {
  it('turns listing + post pages into raw evidence', async () => {
    const noDelay = async () => {};
    const adapter = createEffoySiraAdapter(config(), {
      fetchImpl: fetchRouter(makeRoutes()),
      delay: noDelay,
    });

    const evidence = await adapter.collect(context());

    expect(evidence).toHaveLength(2);
    const first = evidence[0];
    expect(first.sourceJobIdentifier).toBeNull();
    expect(first.sourceUrl).toBe(POST_1);
    expect(first.rawTitle).toBe('MSA Trading Vacancy Fresh Graduates');
    // Content extraction survives a nested <div> and keeps reading past it.
    expect(first.rawDescription).toContain('MSA Trading PLC would like');
    expect(first.rawDescription).toContain('Position 1: Junior Officer');
    // Location/salary lines are lifted from the content text as the field evidence.
    expect(first.rawLocation).toBe('Addis Ababa');
    expect(first.rawSalaryText).toBe('15,000 birr');
    expect(first.rawPublishedDateText).toBe('2026-10-17T09:57:17+00:00');
    expect(first.collectedAt).toEqual(new Date('2026-10-17T09:57:17+00:00'));
    // Company is not a structured field on this source: stays null, never guessed.
    expect(first.rawCompany).toBeNull();
    expect(first.sourceJobIdentifier).toBeNull();
    expect(first.rawPayload).toBeNull();
  });

  it('reads past a nested div inside the content block (balanced-div extraction)', async () => {
    const html = postPage({
      content:
        '<div class="ad-slot"><script>ad()</script></div><p>Position 1: Junior Customer Service Officer</p><p>Deadline: October 20, 2026.</p>',
    });
    const adapter = createEffoySiraAdapter(config(), {
      fetchImpl: fetchRouter({
        'https://effoysira.com/category/job/': listingPage([POST_1]),
        [POST_1]: html,
      }),
      delay: async () => {},
    });

    const evidence = await adapter.collect(context());
    // The nested ad div must not truncate the description.
    expect(evidence[0]?.rawDescription).toContain('Deadline: October 20, 2026');
  });

  it('picks the real content block when the theme renders ad containers with the same class, and never leaks script text', async () => {
    // Regression: live MSA page (2026-10-17) rendered an entry-content ad slot before the
    // article; first-match extraction once produced a 50-char ad script as the whole
    // description, so every field came out UNKNOWN.
    const adSlot =
      '<div class="entry-content is-layout-flow"><script>atOptions = { key: "x" };' +
      '(adsbygoogle = window.adsbygoogle || []).push({});</script></div>';
    const article = postPage({
      content:
        '<div class="code-block"><script>ad(() => "</div>");</script></div><p>Position 1: Junior Officer</p>',
    });
    const page = `<html><head><meta property="article:published_time" content="2026-10-17T09:57:17+00:00" /></head><body>
${adSlot}
<article><h1 class="page-title">MSA Trading Vacancy Fresh Graduates</h1>${article}</body></html>`;
    const adapter = createEffoySiraAdapter(config(), {
      fetchImpl: fetchRouter({
        'https://effoysira.com/category/job/': listingPage([POST_1]),
        [POST_1]: page,
      }),
      delay: async () => {},
    });

    const evidence = await adapter.collect(context());
    expect(evidence[0]?.rawTitle).toBe('MSA Trading Vacancy Fresh Graduates');
    expect(evidence[0]?.rawDescription).toContain('MSA Trading PLC would like');
    expect(evidence[0]?.rawDescription).toContain('How to Apply: send your CV to hr@example.com');
    // Script bodies never leak into the description, even when they contain "</div>".
    expect(evidence[0]?.rawDescription).not.toContain('adsbygoogle');
    expect(evidence[0]?.rawDescription).not.toContain('ad(() =>');
    expect(evidence[0]?.rawLocation).toBe('Addis Ababa');
  });

  it('deduplicates a post linked on two listing pages', async () => {
    const adapter = createEffoySiraAdapter(config(), {
      fetchImpl: fetchRouter({
        'https://effoysira.com/category/job/': listingPage([POST_1]),
        'https://effoysira.com/category/job/page/2/': listingPage([POST_1]),
        [POST_1]: postPage(),
      }),
      delay: async () => {},
    });

    const evidence = await adapter.collect(context());
    expect(evidence).toHaveLength(1);
  });

  it('stops discovery when a listing page is unreachable', async () => {
    const adapter = createEffoySiraAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://effoysira.com/category/job/': 503 }),
      delay: async () => {},
    });

    await expect(adapter.collect(context())).resolves.toEqual([]);
  });

  it('skips an unreachable post but still collects the reachable one', async () => {
    const adapter = createEffoySiraAdapter(config(), {
      fetchImpl: fetchRouter({
        'https://effoysira.com/category/job/': listingPage([POST_1, POST_2]),
        [POST_1]: 500,
        [POST_2]: postPage(),
      }),
      delay: async () => {},
    });

    const evidence = await adapter.collect(context());
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.sourceUrl).toBe(POST_2);
  });

  it('stops between requests once the signal is aborted', async () => {
    const controller = new AbortController();
    const routes = makeRoutes();
    const fetchImpl = (async (input: string | URL) => {
      const res = await fetchRouter(routes)(input);
      // Abort after the first post is served; the next loop iteration must stop.
      if (String(input) === POST_1) controller.abort();
      return res;
    }) as unknown as typeof fetch;
    const adapter = createEffoySiraAdapter(config(), {
      fetchImpl,
      delay: async () => {},
    });

    const evidence = await adapter.collect(context({ signal: controller.signal }));
    expect(evidence).toHaveLength(1);
  });

  it('rate-limits: one delay between listing pages and after each post', async () => {
    let delays = 0;
    const adapter = createEffoySiraAdapter(config(), {
      fetchImpl: fetchRouter(makeRoutes()),
      delay: async () => {
        delays++;
      },
    });

    await adapter.collect(context());
    // page1 -> page2, post1, post2 (no trailing delay after the last page's loop).
    expect(delays).toBe(3);
  });
});

describe('EffoySira adapter — normalize delegates to domain normalizers (ENG-016)', () => {
  it('maps evidence through the shared normalizers and records provenance', async () => {
    const adapter = createEffoySiraAdapter(config(), {
      fetchImpl: fetchRouter(makeRoutes()),
      delay: async () => {},
    });

    const [raw] = await adapter.collect(context());
    const job = await adapter.normalize(raw);

    expect(job.canonicalUrl).toBe(canonicalizeUrl(POST_1));
    expect(job.title).toBe('MSA Trading Vacancy Fresh Graduates');
    expect(job.locationCategory).toBe('ADDIS_ABABA');
    expect(job.salary?.type).toBe(SalaryType.EXACT);
    expect(job.salary?.currency).toBe('ETB');
    expect(job.application.method).toBe('EMAIL');
    expect(job.provenance.title?.provenance).toBe('SOURCE');
    expect(job.provenance.canonicalUrl?.provenance).toBe('DETERMINISTIC');
    expect(job.provenance.locationCategory?.conversionMethod).toBe('LOCATION_GAZETTEER_V1');
    // No company is guessed: the extraction stays UNKNOWN, not inferred from the title.
    expect(job.company).toBeNull();
  });
});

describe('EffoySira adapter — healthCheck', () => {
  it('is HEALTHY when the listing page serves post links', async () => {
    const adapter = createEffoySiraAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://effoysira.com/category/job/': listingPage([POST_1, POST_2]) }),
      delay: async () => {},
    });

    const result = await adapter.healthCheck({ now: NOW, logger: silentWorkerLogger });
    expect(result.status).toBe(HealthStatus.HEALTHY);
    expect(result.sampleSize).toBe(2);
    expect(result.detail).toBeNull();
  });

  it('is DEGRADED when the page loads but shows no posts', async () => {
    const adapter = createEffoySiraAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://effoysira.com/category/job/': '<html><body></body></html>' }),
      delay: async () => {},
    });

    const result = await adapter.healthCheck({ now: NOW, logger: silentWorkerLogger });
    expect(result.status).toBe(HealthStatus.DEGRADED);
    expect(result.sampleSize).toBe(0);
    expect(result.detail).toContain('no post links');
  });

  it('is FAILING on an HTTP error and on a transport error, with the observed detail', async () => {
    const failing = createEffoySiraAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://effoysira.com/category/job/': 500 }),
      delay: async () => {},
    });

    const http = await failing.healthCheck({ now: NOW, logger: silentWorkerLogger });
    expect(http.status).toBe(HealthStatus.FAILING);
    expect(http.detail).toContain('unreachable');

    const thrown = createEffoySiraAdapter(config(), {
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
      delay: async () => {},
    });
    await expect(thrown.healthCheck({ now: NOW, logger: silentWorkerLogger })).resolves.toMatchObject({
      status: HealthStatus.FAILING,
      detail: 'ECONNREFUSED',
    });
  });
});
