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

/** Page 2 returns one different job to verify dedup + pagination; live page N is `{ data, meta }`. */
const LISTING_PAGE_2 = `<!DOCTYPE html><html><body>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"jobs":{"data":[{"id":"ghi","title":"Data Collector","slug":"9kablwen6z-data-collector","type":10,"date_published":"2026-10-22T07:19:05.000000Z","state":"Tigray","description":"<p>Collect data.</p>","date_expiry":"2026-11-04T23:59:59.000000Z","company":{"name":"NRC"},"application_method":"ATS","application_email":null}],"meta":{"pageNumber":2,"itemsPerPage":12,"lastPage":2,"total":13}}}}}</script>
</body></html>`;

/** Duplicate of page 1's first entry to verify cross-page dedup. */
const LISTING_PAGE_DUP = `<!DOCTYPE html><html><body>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"jobs":[{"id":"abc","title":"Senior Accountant","slug":"2qdbkevrhp-senior-accountant","type":8,"date_published":"2026-10-22T08:48:44.235Z","state":"Addis Ababa","description":"<p>We need an accountant. Send your CV to hr@alpha.com</p>","date_expiry":"2026-11-02T23:59:59.000000Z","company":{"name":"Alpha Clinic"},"application_method":"EMAIL","application_email":"hr@alpha.com"}]}}}</script>
</body></html>`;

const EMPTY_PAGE = '<!DOCTYPE html><html><body></body></html>';

/** Entries whose declared fields are the only evidence of an application path. */
const DECLARED_TARGETS_PAGE = `<!DOCTYPE html><html><body>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"jobs":[
{"id":"c1","title":"Career Link Role","slug":"c1-career-link","state":"Addis Ababa","description":"<p>Great role.</p>","date_expiry":"2026-11-02T23:59:59.000000Z","company":{"name":"Beta"},"application_method":"CAREER_PAGE_LINK","career_page_link":"https://careers.example.com/apply/42?job=42"},
{"id":"c2","title":"In Person Role","slug":"c2-in-person","state":"Oromia","description":"<p>Apply in person at our office.</p>","company":{"name":"Gamma"},"application_method":"EMAIL","application_email":"jobs@example.com"},
{"id":"c3","title":"Malformed Email Role","slug":"c3-bad-email","state":"Oromia","description":"<p>Application Deadline: October 30, 2026</p>","date_expiry":"soon","company":{"name":"Delta"},"application_method":"EMAIL","application_email":"not-an-email"},
{"id":"c4","title":"Both Role","slug":"c4-both","state":"Amhara","description":"<p>Both channels.</p>","company":{"name":"Epsilon"},"application_method":"BOTH","application_email":"both@example.com","career_page_link":"https://careers.example.com/both"}
]}}}</script>
</body></html>`;

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

    const { records: evidence } = await adapter.collect(context());

    expect(evidence).toHaveLength(3);
    const first = evidence[0];
    // The slug's leading id segment, never the title text after it (audit M6): a publisher
    // retitling a posting must not fork its identity.
    expect(first.sourceJobIdentifier).toBe('2qdbkevrhp');
    expect(first.sourceUrl).toBe('https://ethiojobs.net/job/2qdbkevrhp-senior-accountant');
    expect(evidence[1]?.sourceJobIdentifier).toBe('t8jxf0tin5');
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

    const { records: evidence } = await adapter.collect(context());
    // Page 1 had 2, page 2 re-emits the first → only 2 survive.
    expect(evidence).toHaveLength(2);
  });

  it('stops discovery when a listing page is unreachable', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': 503 }),
      delay: async () => {},
    });

    await expect(adapter.collect(context())).resolves.toEqual({
      records: [],
      catalogueExhausted: false,
      oldestListingPublishedAt: null,
      listingNotNewestFirst: false,
      // The listing answered 503: a source failure, not a parse miss (audit M5).
      httpFailures: 1,
    });
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

    const { records: evidence } = await adapter.collect(context({ signal: controller.signal }));
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

describe('Ethiojobs adapter — catalogue coverage (FR-019)', () => {
  it('reports the listing exhausted when the run reaches meta.lastPage', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({
        'https://ethiojobs.net/jobs': LISTING_PAGE_1,
        'https://ethiojobs.net/jobs?page=2': LISTING_PAGE_2,
      }),
      delay: async () => {},
    });

    // Page 2's meta declares lastPage 2: the run read the listing to its end.
    const { records, catalogueExhausted } = await adapter.collect(context());
    expect(catalogueExhausted).toBe(true);
    expect(records).toHaveLength(3);
  });

  it('does not report coverage while pages remain beyond the page budget', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({
        'https://ethiojobs.net/jobs': LISTING_PAGE_1,
        'https://ethiojobs.net/jobs?page=2': EMPTY_PAGE.replace(
          '<body>',
          '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"jobs":{"data":[],"meta":{"pageNumber":2,"lastPage":101}}}}}</script>',
        ) + '</body></html>',
      }),
      delay: async () => {},
    });

    const { catalogueExhausted, oldestListingPublishedAt } = await adapter.collect(context());
    expect(catalogueExhausted).toBe(false);
    // Every entry read was dated, so the run still knows the window it covered.
    expect(oldestListingPublishedAt).toEqual(new Date('2026-10-22T00:00:00.000Z'));
  });

  it('reports the oldest publication date across the pages it read', async () => {
    // The older posting is on the later page, which is what a newest-first listing looks like.
    const olderPage2 = LISTING_PAGE_2
      .replace('2026-10-22T07:19:05.000000Z', '2026-10-20T07:19:05.000000Z')
      .replace('"lastPage":2', '"lastPage":101');
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({
        'https://ethiojobs.net/jobs': LISTING_PAGE_1,
        'https://ethiojobs.net/jobs?page=2': olderPage2,
      }),
      delay: async () => {},
    });

    const result = await adapter.collect(context());
    expect(result.catalogueExhausted).toBe(false);
    expect(result.oldestListingPublishedAt).toEqual(new Date('2026-10-20T00:00:00.000Z'));
    expect(result.listingNotNewestFirst).toBe(false);
  });

  it('voids the window claim when the listing is not served newest-first', async () => {
    // A posting on page 2 that is newer than the last entry of page 1 means the pages the run
    // did NOT read can hold postings newer than the floor — which is exactly the case the
    // lifecycle sweep would retire by mistake. The claim is voided, and says why (audit M6).
    const outOfOrderPage2 = LISTING_PAGE_2.replace(
      '2026-10-22T07:19:05.000000Z',
      '2026-10-23T07:19:05.000000Z',
    );
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({
        'https://ethiojobs.net/jobs': LISTING_PAGE_1,
        'https://ethiojobs.net/jobs?page=2': outOfOrderPage2,
      }),
      delay: async () => {},
    });

    const result = await adapter.collect(context());
    expect(result.records).toHaveLength(3);
    expect(result.oldestListingPublishedAt).toBeNull();
    expect(result.catalogueExhausted).toBe(false);
    expect(result.listingNotNewestFirst).toBe(true);
  });

  it('makes no window claim when an entry it read carries no date', async () => {
    const undated = LISTING_PAGE_1.replace('"date_published":"2026-10-22T08:44:05.000000Z",', '');
    const adapter = createEthiojobsAdapter(config({ options: { maxListingPages: 1 } }), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': undated }),
      delay: async () => {},
    });

    const result = await adapter.collect(context());
    // An undated entry could be the oldest one read, so the floor would be a guess.
    expect(result.oldestListingPublishedAt).toBeNull();
  });

  it('makes no window claim when an entry cannot be identified', async () => {
    const unidentifiable = `<!DOCTYPE html><html><body>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"jobs":{"data":[
{"title":"No slug","date_published":"2026-10-22T08:00:00.000Z","company":{"name":"X"}},
{"id":"ok","title":"Usable Role","slug":"ok-usable-role","date_published":"2026-10-21T08:00:00.000Z","company":{"name":"Y"}}
],"meta":{"pageNumber":1,"lastPage":50}}}}}</script>
</body></html>`;
    const adapter = createEthiojobsAdapter(config({ options: { maxListingPages: 1 } }), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': unidentifiable }),
      delay: async () => {},
    });

    const result = await adapter.collect(context());
    // The unidentifiable entry is a record the run did not observe, so it saw nothing
    // bounded it can claim.
    expect(result.records).toHaveLength(1);
    expect(result.oldestListingPublishedAt).toBeNull();
  });

  it('does not report coverage when the payload carries no pagination metadata', async () => {
    // The array shape (older captures) declares no lastPage, so the run cannot claim it
    // saw everything even though it stopped at its page budget.
    const adapter = createEthiojobsAdapter(config({ options: { maxListingPages: 1 } }), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': LISTING_PAGE_1 }),
      delay: async () => {},
    });

    const result = await adapter.collect(context());
    expect(result.catalogueExhausted).toBe(false);
    expect(result.records).toHaveLength(2);
    expect(result.oldestListingPublishedAt).toEqual(new Date('2026-10-22T00:00:00.000Z'));
  });
});

describe('Ethiojobs adapter — normalize delegates to domain normalizers (ENG-016)', () => {
  it('maps structured evidence through the shared normalizers and records provenance', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': LISTING_PAGE_1 }),
      delay: async () => {},
    });

    const { records } = await adapter.collect(context());
    const [raw] = records;
    const job = await adapter.normalize(raw);

    expect(job.canonicalUrl).toBe(canonicalizeUrl('https://ethiojobs.net/job/2qdbkevrhp-senior-accountant'));
    expect(job.title).toBe('Senior Accountant');
    expect(job.company).toBe('Alpha Clinic');
    expect(job.locationCategory).toBe('ADDIS_ABABA');
    // application_method EMAIL + application_email present → EMAIL target, sourced from the
    // declared field rather than the description's incidental address.
    expect(job.application.method).toBe('EMAIL');
    expect(job.application.applyEmail).toBe('hr@alpha.com');
    expect(job.provenance.applicationMethod?.conversionMethod).toBe(
      'APPLICATION_TARGET_DECLARED_V1',
    );
    expect(job.provenance.applicationMethod?.evidence).toBe('application_method=EMAIL');
    // date_expiry is a declared ISO timestamp; the shared date parser resolves it and the
    // deadline normalizer stores it at UTC midnight.
    expect(job.applicationDeadline.deadlineAt?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(job.applicationDeadline.evidence).toBe('2026-11-02T23:59:59.000000Z');
    expect(job.provenance.title?.provenance).toBe('SOURCE');
    expect(job.provenance.canonicalUrl?.provenance).toBe('DETERMINISTIC');
    expect(job.provenance.locationCategory?.conversionMethod).toBe('LOCATION_GAZETTEER_V1');
  });

  it('maps declared career-page and both-channel records to a usable path', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': DECLARED_TARGETS_PAGE }),
      delay: async () => {},
    });
    const { records: evidence } = await adapter.collect(context());
    const normalized = await Promise.all(evidence.map((raw) => adapter.normalize(raw)));
    const byTitle = new Map(normalized.map((job) => [job.title, job]));

    const career = byTitle.get('Career Link Role')!;
    expect(career.application).toMatchObject({
      method: 'ONLINE_URL',
      applyUrl: 'https://careers.example.com/apply/42?job=42',
      applyEmail: null,
    });

    // Both channels declared: the direct link wins, matching the text extractor's precedence.
    const both = byTitle.get('Both Role')!;
    expect(both.application).toMatchObject({
      method: 'ONLINE_URL',
      applyUrl: 'https://careers.example.com/both',
      applyEmail: null,
    });
  });

  it('prefers the declared method over a conflicting in-text instruction', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': DECLARED_TARGETS_PAGE }),
      delay: async () => {},
    });
    const { records: evidence } = await adapter.collect(context());
    const raw = evidence.find((e) => e.rawTitle === 'In Person Role')!;
    const job = await adapter.normalize(raw);

    // The description says "apply in person"; the publisher's own field says EMAIL. A declared
    // field is the stronger evidence, so the text guess does not win.
    expect(job.application.method).toBe('EMAIL');
    expect(job.application.applyEmail).toBe('jobs@example.com');
  });

  it('never invents a path from a malformed declared field, and still reads a stated deadline', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': DECLARED_TARGETS_PAGE }),
      delay: async () => {},
    });
    const { records: evidence } = await adapter.collect(context());
    const raw = evidence.find((e) => e.rawTitle === 'Malformed Email Role')!;
    const job = await adapter.normalize(raw);

    expect(job.application.method).toBe('UNKNOWN');
    // The declared `date_expiry` is "soon" (unparsable), so the labelled description deadline
    // supplies the date instead of the declared value being trusted or the deadline dropped.
    expect(job.applicationDeadline.deadlineAt?.toISOString()).toBe('2026-10-30T00:00:00.000Z');
  });

  it('leaves a declared ATS record with no link or email as UNKNOWN', async () => {
    const adapter = createEthiojobsAdapter(config(), {
      fetchImpl: fetchRouter({ 'https://ethiojobs.net/jobs': LISTING_PAGE_1 }),
      delay: async () => {},
    });

    const { records: evidence } = await adapter.collect(context());
    // Second entry is "Driver" with application_method ATS and no email in the description.
    // No usable path is declared, so the honest state is UNKNOWN - not a fabricated target.
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
