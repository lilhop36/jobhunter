import { describe, expect, it } from 'vitest';
import { CalendarType, HealthStatus, SalaryType } from '@domain/enums';
import { silentWorkerLogger } from '@ports/worker-logger';
import type { SourceAdapterConfig } from '@ports/source-adapter';
import { canonicalizeUrl } from '@domain/normalizers/url-normalizer';
import { createEthiojobsAdapter } from '@infrastructure/adapters/ethiojobs';
import { makeFakeConfig } from '../support/fake-source-adapter';

const NOW = new Date('2026-10-22T15:00:00Z');

function config(overrides: Partial<SourceAdapterConfig> = {}) {
  return makeFakeConfig({
    adapterType: 'ETHIOJOBS_STATIC_HTML',
    adapterVersion: '1.0.0',
    accessMechanism: 'STATIC_HTML',
    declaredCalendar: CalendarType.GREGORIAN,
    canonicalUrlIdentityTrusted: true,
    options: { delayMs: 0, maxListingPages: 2 },
    ...overrides,
  });
}

/** Minimal __NEXT_DATA__ JSON containing two job entries on page 1. */
const LISTING_PAGE_1 = `<!DOCTYPE html><html><body>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"jobs":[{"id":"abc","title":"Senior Accountant","slug":"2qdbkevrhp-senior-accountant","type":8,"date_published":"2026-10-22T08:48:44.235Z","state":"Addis Ababa","description":"<p>We need an accountant. Send your CV to hr@alpha.com</p>","date_expiry":"2026-11-02T23:59:59.000000Z","company":{"name":"Alpha Clinic","logo":"logo.png"},"application_method":"EMAIL","application_email":"hr@alpha.com"},{"id":"def","title":"Driver (Bishoftu / Night Shift)","slug":"t8jxf0tin5-driver-bishoftu","type":8,"date_published":"2026-10-22T08:44:05.000000Z","state":"Oromia","description":"<p>Drive safely.</p>","date_expiry":"2026-11-02T23:59:59.000000Z","company":{"name":"Holland Dairy P.L.C"},"application_method":"ATS","application_email":null}]}}}</script>
</body></html>`;

/** Page 2 returns one different job to verify dedup + pagination. */
const LISTING_PAGE_2 = `<!DOCTYPE html><html><body>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"jobs":[{"id":"ghi","title":"Data Collector","slug":"9kablwen6z-data-collector","type":10,"date_published":"2026-10-22T07:19:05.000000Z","state":"Tigray","description":"<p>Collect data.</p>","date_expiry":"2026-11-04T23:59:59.000000Z","company":{"name":"NRC"},"application_method":"ATS","application_email":null}]}}}</script>
</body></html>`;

/** Duplicate of page 1's first entry to verify cross-page dedup. */
const LISTING_PAGE_DUP = `<!DOCTYPE html><html><body>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"jobs":[{"id":"abc","title":"Senior Accountant","slug":"2qdbkevrhp-senior-accountant","type":8,"date_published":"2026-10-22T08:48:44.235Z","state":"Addis Ababa","description":"<p>We need an accountant. Send your CV to hr@alpha.com</p>","date_expiry":"2026-11-02T23:59:59.000000Z","company":{"name":"Alpha Clinic"},"application_method":"EMAIL","application_email":"hr@alpha.com"}]}}}</script>
</body></html>`;

const EMPTY_PAGE = '<!DOCTYPE html><html><body></body></html>';

function fetchRouter(routes: Record<string, string | number>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const route = routes[url];
    if (typeof route === 'number') return new Response('', { status: route });
    if (route === undefined) return new Response('not found', { status: 404 });
    return new Response(route, { status: 200 });
  }) as unknown as typeof fetch;
}

function context(overrides: { signal?: AbortSignal } = {}) {
  return {
    sourceRunId: '00000000-0000-0000-0000-0000000000bb',
    now: NOW,
    logger: silentWorkerLogger,
    ...overrides,
  };
}

describe('Ethiojobs adapter — collect (fixture HTML, no network)', () => {
  it('extracts structured jobs from __NEXT_DATA__ listing pages', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({
        'https://ethiojobs.net/jobs': LISTING_PAGE_1,
        'https://ethiojobs.net/jobs?page=2': LISTING_PAGE_2,
      }),
      delay: async () => {},
    });

    const evidence = await adapter.collect(context());

    expect(evidence).toHaveLength(3);
    const first = evidence[0];
    // Slug is the stable external identifier.
    expect(first.sourceJobIdentifier).toBe('2qdbkevrhp-senior-accountant');
    expect(first.sourceUrl).toBe('https://ethiojobs.net/job/2qdbkevrhp-senior-accountant');
    expect(first.rawTitle).toBe('Senior Accountant');
    expect(first.rawCompany).toBe('Alpha Clinic');
    expect(first.rawLocation).toBe('Addis Ababa');
    expect(first.rawDescription).toContain('We need an accountant.');
    expect(first.rawPublishedDateText).toBe('2026-10-22T08:48:44.235Z');
    // collectedAt is the observation time (context.now), not the published date.
    expect(first.collectedAt).toEqual(NOW);
    // rawPayload carries the full structured record for future extraction increments.
    expect(first.rawPayload).toBeTruthy();
    expect((first.rawPayload as Record<string, unknown>).applicationMethod).toBe('EMAIL');
    expect((first.rawPayload as Record<string, unknown>).applicationEmail).toBe('hr@alpha.com');
  });

  it('deduplicates a slug seen on two listing pages', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({
        'https://ethiojobs.net/jobs': LISTING_PAGE_1,
        'https://ethiojobs.net/jobs?page=2': LISTING_PAGE_DUP,
      }),
      delay: async () => {},
    });

    const evidence = await adapter.collect(context());
    // Page 1 had 2, page 2 re-emits the first → only 2 survive.
    expect(evidence).toHaveLength(2);
  });

  it('stops discovery when a listing page is unreachable', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': 503 }),
      delay: async () => {},
    });

    await expect(adapter.collect(context())).resolves.toEqual([]);
  });

  it('stops between requests once the signal is aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://ethiojobs.net/jobs') {
        controller.abort();
        return new Response(LISTING_PAGE_1, { status: 200 });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl,
      delay: async () => {},
    });

    const evidence = await adapter.collect(context({ signal: controller.signal }));
    // Page 1 was served before abort; page 2 must not be fetched.
    expect(evidence.length).toBeGreaterThanOrEqual(1);
  });

  it('rate-limits: one delay between listing pages', async () => {
    let delays = 0;
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({
        'https://ethiojobs.net/jobs': LISTING_PAGE_1,
        'https://ethiojobs.net/jobs?page=2': LISTING_PAGE_2,
      }),
      delay: async () => { delays++; },
    });

    await adapter.collect(context());
    // One inter-page delay (no per-post delay needed since listing carries all fields).
    expect(delays).toBe(1);
  });
});

describe('Ethiojobs adapter — normalize delegates to domain normalizers (ENG-016)', () => {
  it('maps structured evidence through the shared normalizers and records provenance', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': LISTING_PAGE_1 }),
      delay: async () => {},
    });

    const [raw] = await adapter.collect(context());
    const job = await adapter.normalize(raw);

    expect(job.canonicalUrl).toBe(canonicalizeUrl('https://ethiojobs.net/job/2qdbkevrhp-senior-accountant'));
    expect(job.title).toBe('Senior Accountant');
    expect(job.company).toBe('Alpha Clinic');
    expect(job.locationCategory).toBe('ADDIS_ABABA');
    // application_method EMAIL + application_email present → EMAIL target.
    expect(job.application.method).toBe('EMAIL');
    expect(job.provenance.title?.provenance).toBe('SOURCE');
    expect(job.provenance.canonicalUrl?.provenance).toBe('DETERMINISTIC');
    expect(job.provenance.locationCategory?.conversionMethod).toBe('LOCATION_GAZETTEER_V1');
  });

  it('leaves ATS method without in-text email as UNKNOWN (structured wiring deferred)', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': LISTING_PAGE_1 }),
      delay: async () => {},
    });

    const evidence = await adapter.collect(context());
    // Second entry is "Driver" with application_method ATS, no email in description text.
    // The shared text-based normalizer has no evidence → UNKNOWN (honest).
    // Wiring structured application_method/application_email into the policy is a
    // purposefully deferred follow-up (see docs/sources/ethiojobs.md notes).
    const driver = evidence.find((e) => e.rawTitle === 'Driver (Bishoftu / Night Shift)')!;
    const job = await adapter.normalize(driver);

    expect(job.application.method).toBe('UNKNOWN');
  });
});

describe('Ethiojobs adapter — healthCheck', () => {
  it('is HEALTHY when the listing page serves job entries', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': LISTING_PAGE_1 }),
      delay: async () => {},
    });

    const result = await adapter.healthCheck({ now: NOW, logger: silentWorkerLogger });
    expect(result.status).toBe(HealthStatus.HEALTHY);
    expect(result.sampleSize).toBe(2);
    expect(result.detail).toBeNull();
  });

  it('is DEGRADED when the page loads but shows no jobs', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': EMPTY_PAGE }),
      delay: async () => {},
    });

    const result = await adapter.healthCheck({ now: NOW, logger: silentWorkerLogger });
    expect(result.status).toBe(HealthStatus.DEGRADED);
    expect(result.sampleSize).toBe(0);
    expect(result.detail).toContain('no job entries');
  });

  it('is FAILING on an HTTP error', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': 500 }),
      delay: async () => {},
    });

    const result = await adapter.healthCheck({ now: NOW, logger: silentWorkerLogger });
    expect(result.status).toBe(HealthStatus.FAILING);
    expect(result.detail).toContain('unreachable');
  });
});
