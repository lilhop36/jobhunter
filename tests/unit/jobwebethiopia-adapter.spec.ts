import { describe, expect, it } from 'vitest';
import { CalendarType, HealthStatus } from '@domain/enums';
import { silentWorkerLogger } from '@ports/worker-logger';
import type { SourceAdapterConfig } from '@ports/source-adapter';
import { canonicalizeUrl } from '@domain/normalizers/url-normalizer';
import { createJobWebEthiopiaAdapter } from '@infrastructure/adapters/jobwebethiopia';
import { makeFakeConfig } from '../support/fake-source-adapter';

const NOW = new Date('2026-10-22T15:00:00Z');

const BASE = 'https://jobwebethiopia.com';

const LISTING = `${BASE}/jobs/`;
const PAGE_2 = `${BASE}/jobs/page/2/`;
const TM_URL = `${BASE}/jobs/secretary-receptionist-tm-law-firm/`;
const BANK_URL = `${BASE}/jobs/customer-service-officer-at-alpha-bank/`;
const THIRD_URL = `${BASE}/jobs/driver-at-beta-transport/`;

function config(overrides: Partial<SourceAdapterConfig> = {}) {
  return makeFakeConfig({
    adapterType: 'JOBWEBETHIOPIA_STATIC_HTML',
    adapterVersion: '1.0.0',
    accessMechanism: 'STATIC_HTML',
    declaredCalendar: CalendarType.GREGORIAN,
    canonicalUrlIdentityTrusted: true,
    options: { delayMs: 0, maxListingPages: 1, maxPosts: 6 },
    ...overrides,
  });
}

/** A listing card exactly as the theme renders it (live-verified 2026-10-22). */
function card(url: string, title: string): string {
  return `<li class="job">
<div id="titlo"><strong><a href="${url}">${title}</a></strong></div>
<div id="type-tag"><span class="jtype full-time">Full-Time</span></div>
<div id="exc"><div class="lista">Short excerpt â€¦</div></div>
<div id="location"><strong>Location: </strong> Ethiopia </div>
<div id="date"><span class="year"> 16/Oct/2026</span></div>
</li>`;
}

function listingHtml(...cards: string[]): string {
  return `<!DOCTYPE html><html><body><ol class="jobs">${cards.join('\n')}</ol></body></html>`;
}

const LISTING_PAGE_1 = listingHtml(
  card(TM_URL, 'Secretary and Receptionist at TM Law firm'),
  card(BANK_URL, 'Customer Service Officer at Alpha Bank'),
);

const LISTING_PAGE_2 = listingHtml(card(THIRD_URL, 'Driver at Beta Transport'));

/** Detail page markup as the theme renders it; the email is Cloudflare-obfuscated. */
function detailHtml(options: {
  title: string;
  company: string;
  state: string;
  date?: string;
  salary?: string | null;
  application?: string;
}): string {
  const salaryLine =
    options.salary === null || options.salary === undefined
      ? ''
      : `<li><strong>Salary:</strong> ${options.salary}</li>`;
  return `<!DOCTYPE html><html><body>
<div class="section single">
  <div class="section_header">
    <div class="date"><strong>${options.date ?? '16 Oct 2026'} </strong></div>
    <h1 class="title">${options.title}<br><br></h1>
  </div>
  <div class="section_content">
    <ul>
      <li id="topss"><b>Company:</b> <a href="" rel="nofollow">${options.company}</a> </li>
      <li id="topss"><b>Location:</b> Ethiopia</li>
      <li id="topss"><b>State:</b> <a href="${BASE}/job-location/addis-ababa-jobs/" rel="tag">${options.state}</a></li>
      <li id="topss"><b>Job type:</b>  <span class="jtype full-time">Full-Time</span></li>
      <li id="topss"><b>Job category:</b> <a href="${BASE}/job-category/admin/" rel="tag">Administrative Jobs in Ethiopia</a></li>
    </ul>
    <HR COLOR="#DD4198" WIDTH="100%"SIZE="1">
    <h1 class="how-to-apply">Job Description</h1>
    <font size="2"> <div class="job-detail-description">
<div class="job-detail-description-details">
<p><strong>${options.company}</strong> is a company in Addis Ababa inviting applicants for a vacancy.</p>
<ul>
<li><strong>Job Title:</strong> ${options.title}</li>
<li><strong>Employment Type:</strong> Full-Time (Permanent)</li>
${salaryLine}
</ul>
<p><strong>Job Summary</strong></p>
<p>The role serves as the first point of contact, managing reception and providing administrative support.</p>
</div>
</div></font>
    <HR COLOR="#DD4198" WIDTH="100%"SIZE="1"><br>
    <h1 class="how-to-apply">Method of Application</h1>
    <font size="3">${
      options.application ??
      'Interested applicants should submit their CV within 7 working days.'
    }</font>
    <HR COLOR="#DD4198" WIDTH="100%"SIZE="1"><br>
    <div id="apply_form" class="section_content ">
      <h2>Apply for this Job</h2>
      <form action="${BASE}/jobs/x/#apply_form_result" method="post">
        <input type="text" name="your_email" id="your_email" value="" />
      </form>
    </div>
  </div>
</div>
</body></html>`;
}

const TM_DETAIL = detailHtml({
  title: 'Secretary and Receptionist at TM Law firm',
  company: 'TM Law firm',
  state: 'Addis Ababa Jobs',
  salary: 'Negotiable',
  application:
    'Send your documents to <a href="${BASE}/jobs/x/"><span class="__cf_email__" data-cfemail="e48e8b8697a4899d9089888593828d9689ca878b89">[email&#160;protected]</span></a> with the subject line.',
});

const BANK_DETAIL = detailHtml({
  title: 'Customer Service Officer at Alpha Bank',
  company: 'Alpha Bank',
  state: 'Oromia Jobs',
  salary: null,
});

const THIRD_DETAIL = detailHtml({
  title: 'Driver at Beta Transport',
  company: 'Beta Transport',
  state: 'Addis Ababa Jobs',
});

const EMPTY_PAGE = '<!DOCTYPE html><html><body><ol class="jobs"></ol></body></html>';

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
    sourceRunId: '00000000-0000-0000-0000-0000000000cc',
    now: NOW,
    logger: silentWorkerLogger,
    ...overrides,
  };
}

describe('JobWebEthiopia adapter â€” collect (fixture HTML, no network)', () => {
  it('reads each posting page and captures the fields the page declares', async () => {
    const adapter = createJobWebEthiopiaAdapter(config(), {
      fetchImpl: fetchRouter({
        [LISTING]: LISTING_PAGE_1,
        [TM_URL]: TM_DETAIL,
        [BANK_URL]: BANK_DETAIL,
      }),
      delay: async () => {},
    });

    const evidence = await adapter.collect(context());

    expect(evidence).toHaveLength(2);
    const first = evidence[0];
    // The permalink slug is not a published id: identity is the canonical URL.
    expect(first.sourceJobIdentifier).toBeNull();
    expect(first.sourceUrl).toBe(TM_URL);
    expect(first.rawTitle).toBe('Secretary and Receptionist at TM Law firm');
    expect(first.rawCompany).toBe('TM Law firm');
    // `State:` classifies; it wins over the generic `Location: Ethiopia`.
    expect(first.rawLocation).toBe('Addis Ababa Jobs');
    expect(first.rawPublishedDateText).toBe('16 Oct 2026');
    expect(first.rawSalaryText).toBe('Negotiable');
    expect(first.rawDescription).toContain('managing reception');
    // The application section is part of the posting body the reader sees.
    expect(first.rawDescription).toContain('Method of Application');
    // Observation time is the collection, not the published date.
    expect(first.collectedAt).toEqual(NOW);
    expect(first.rawPayload).toMatchObject({
      jobType: 'Full-Time',
      category: 'Administrative Jobs in Ethiopia',
      locationText: 'Ethiopia',
      stateText: 'Addis Ababa Jobs',
      cloudflareEmailsDecoded: 1,
    });
  });

  it('decodes the Cloudflare-obfuscated application email the page shows a reader', async () => {
    const adapter = createJobWebEthiopiaAdapter(config(), {
      fetchImpl: fetchRouter({ [LISTING]: LISTING_PAGE_1, [TM_URL]: TM_DETAIL, [BANK_URL]: BANK_DETAIL }),
      delay: async () => {},
    });

    const [first] = await adapter.collect(context());

    expect(first.rawDescription).toContain('jobs@mytmlawfirm.com');
    expect(first.rawDescription).not.toContain('[email');
    expect(first.rawDescription).not.toContain('data-cfemail');
  });

  it('caps the run at maxPosts posting pages', async () => {
    const fetched: string[] = [];
    const routes: Record<string, string> = {
      [LISTING]: listingHtml(
        card(TM_URL, 'Secretary at TM Law firm'),
        card(BANK_URL, 'Customer Service Officer at Alpha Bank'),
        card(THIRD_URL, 'Driver at Beta Transport'),
      ),
      [TM_URL]: TM_DETAIL,
      [BANK_URL]: BANK_DETAIL,
      [THIRD_URL]: THIRD_DETAIL,
    };
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      fetched.push(url);
      return new Response(routes[url] ?? '', { status: routes[url] === undefined ? 404 : 200 });
    }) as unknown as typeof fetch;

    const adapter = createJobWebEthiopiaAdapter(
      config({ options: { delayMs: 0, maxListingPages: 1, maxPosts: 2 } }),
      { fetchImpl, delay: async () => {} },
    );

    const evidence = await adapter.collect(context());
    expect(evidence).toHaveLength(2);
    expect(fetched).not.toContain(THIRD_URL);
  });

  it('skips a posting whose page cannot be read, rather than capturing the excerpt', async () => {
    const adapter = createJobWebEthiopiaAdapter(config(), {
      fetchImpl: fetchRouter({ [LISTING]: LISTING_PAGE_1, [TM_URL]: TM_DETAIL, [BANK_URL]: 500 }),
      delay: async () => {},
    });

    const evidence = await adapter.collect(context());
    expect(evidence).toHaveLength(1);
    expect(evidence[0].sourceUrl).toBe(TM_URL);
  });

  it('walks the second listing page and drops a card seen twice', async () => {
    const adapter = createJobWebEthiopiaAdapter(
      config({ options: { delayMs: 0, maxListingPages: 2, maxPosts: 10 } }),
      {
        fetchImpl: fetchRouter({
          [LISTING]: LISTING_PAGE_1,
          [PAGE_2]: listingHtml(
            card(TM_URL, 'Secretary and Receptionist at TM Law firm'),
            card(THIRD_URL, 'Driver at Beta Transport'),
          ),
          [TM_URL]: TM_DETAIL,
          [BANK_URL]: BANK_DETAIL,
          [THIRD_URL]: THIRD_DETAIL,
        }),
        delay: async () => {},
      },
    );

    const evidence = await adapter.collect(context());
    expect(evidence.map((row) => row.sourceUrl)).toEqual([TM_URL, BANK_URL, THIRD_URL]);
  });

  it('waits the Crawl-delay between every request, not between pages only', async () => {
    let delays = 0;
    const adapter = createJobWebEthiopiaAdapter(config(), {
      fetchImpl: fetchRouter({ [LISTING]: LISTING_PAGE_1, [TM_URL]: TM_DETAIL, [BANK_URL]: BANK_DETAIL }),
      delay: async () => {
        delays++;
      },
    });

    await adapter.collect(context());
    // Three requests (one listing + two postings) â†’ two waits.
    expect(delays).toBe(2);
  });

  it('stops between requests once the signal is aborted', async () => {
    const controller = new AbortController();
    const fetched: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url === LISTING) {
        controller.abort();
        return new Response(LISTING_PAGE_1, { status: 200 });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const adapter = createJobWebEthiopiaAdapter(config(), {
      fetchImpl,
      delay: async () => {},
    });

    await adapter.collect(context({ signal: controller.signal }));
    expect(fetched).toEqual([LISTING]);
  });

  it('returns nothing when the listing is unreachable', async () => {
    const adapter = createJobWebEthiopiaAdapter(config(), {
      fetchImpl: fetchRouter({ [LISTING]: 503 }),
      delay: async () => {},
    });

    await expect(adapter.collect(context())).resolves.toEqual([]);
  });
});

describe('JobWebEthiopia adapter â€” normalize delegates to domain normalizers (ENG-016)', () => {
  it('maps the captured evidence through the shared normalizers and records provenance', async () => {
    const adapter = createJobWebEthiopiaAdapter(config(), {
      fetchImpl: fetchRouter({ [LISTING]: LISTING_PAGE_1, [TM_URL]: TM_DETAIL, [BANK_URL]: BANK_DETAIL }),
      delay: async () => {},
    });

    const [raw] = await adapter.collect(context());
    const job = await adapter.normalize(raw);

    expect(job.canonicalUrl).toBe(canonicalizeUrl(TM_URL));
    expect(job.locationCategory).toBe('ADDIS_ABABA');
    expect(job.company).toBe('TM Law firm');
    // The decoded address is the posting's own application path.
    expect(job.application.method).toBe('EMAIL');
    expect(job.application.applyEmail).toBe('jobs@mytmlawfirm.com');
    // Employment type is mined from the description text ("Employment Type: Full-Time").
    expect(job.employmentType).toBe('FULL_TIME');
    expect(job.provenance.title?.provenance).toBe('SOURCE');
    expect(job.provenance.locationCategory?.conversionMethod).toBe('LOCATION_GAZETTEER_V1');
    expect(job.provenance.applicationMethod?.conversionMethod).toBe('APPLICATION_TARGET_V1');
  });

  it('keeps a posting whose text carries no application path at UNKNOWN', async () => {
    const adapter = createJobWebEthiopiaAdapter(config(), {
      fetchImpl: fetchRouter({ [LISTING]: LISTING_PAGE_1, [TM_URL]: TM_DETAIL, [BANK_URL]: BANK_DETAIL }),
      delay: async () => {},
    });

    const evidence = await adapter.collect(context());
    const bank = evidence.find((row) => row.sourceUrl === BANK_URL)!;
    const job = await adapter.normalize(bank);

    expect(job.application.method).toBe('UNKNOWN');
    expect(job.locationCategory).toBe('ETHIOPIA_REGION');
    // No obfuscated address on that page: the count reports zero, not an assumption.
    expect((bank.rawPayload as Record<string, unknown>).cloudflareEmailsDecoded).toBe(0);
  });

  it('leaves the published date UNKNOWN when the page states none', async () => {
    const adapter = createJobWebEthiopiaAdapter(
      config({ options: { delayMs: 0, maxListingPages: 1, maxPosts: 1 } }),
      {
        fetchImpl: fetchRouter({
          [LISTING]: LISTING_PAGE_1,
          [TM_URL]: detailHtml({
            title: 'Secretary at TM Law firm',
            company: 'TM Law firm',
            state: 'Addis Ababa Jobs',
            date: '',
          }),
          [BANK_URL]: BANK_DETAIL,
        }),
        delay: async () => {},
      },
    );

    const [raw] = await adapter.collect(context());
    const job = await adapter.normalize(raw);

    expect(job.publishedDate.calendar).toBe('UNKNOWN');
    expect(job.publishedDate.publishedAt).toBeNull();
  });
});

describe('JobWebEthiopia adapter â€” healthCheck', () => {
  it('is HEALTHY when the listing page serves job cards', async () => {
    const adapter = createJobWebEthiopiaAdapter(config(), {
      fetchImpl: fetchRouter({ [LISTING]: LISTING_PAGE_1 }),
      delay: async () => {},
    });

    const result = await adapter.healthCheck({ now: NOW, logger: silentWorkerLogger });
    expect(result.status).toBe(HealthStatus.HEALTHY);
    expect(result.sampleSize).toBe(2);
    expect(result.detail).toBeNull();
  });

  it('is DEGRADED when the page loads but shows no cards', async () => {
    const adapter = createJobWebEthiopiaAdapter(config(), {
      fetchImpl: fetchRouter({ [LISTING]: EMPTY_PAGE }),
      delay: async () => {},
    });

    const result = await adapter.healthCheck({ now: NOW, logger: silentWorkerLogger });
    expect(result.status).toBe(HealthStatus.DEGRADED);
    expect(result.sampleSize).toBe(0);
    expect(result.detail).toContain('no job cards');
  });

  it('is FAILING on an HTTP error', async () => {
    const adapter = createJobWebEthiopiaAdapter(config(), {
      fetchImpl: fetchRouter({ [LISTING]: 500 }),
      delay: async () => {},
    });

    const result = await adapter.healthCheck({ now: NOW, logger: silentWorkerLogger });
    expect(result.status).toBe(HealthStatus.FAILING);
    expect(result.detail).toContain('unreachable');
  });
});
