import { silentWorkerLogger } from '@ports/worker-logger';
import { FakeSourceAdapter, makeFakeConfig, makeRawJob } from '../support/fake-source-adapter';

const NOW = new Date('2026-10-13T00:00:00.000Z');
const CONTEXT = {
  sourceRunId: '00000000-0000-0000-0000-0000000000aa',
  now: NOW,
  logger: silentWorkerLogger,
};

describe('JobSourceAdapter contract', () => {
  it('collect returns a defensive copy of the seeded raw evidence', async () => {
    const row = makeRawJob({ sourceJobIdentifier: 'job-1', rawTitle: 'Backend Engineer' });
    const adapter = new FakeSourceAdapter(makeFakeConfig(), [row]);

    const collected = await adapter.collect(CONTEXT);

    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual(row);
    expect(collected[0]).not.toBe(row);
  });

  it('normalize delegates URL, location and salary work to domain normalizers', async () => {
    const adapter = new FakeSourceAdapter(makeFakeConfig());
    const job = await adapter.normalize(
      makeRawJob({
        sourceUrl: 'https://Example.com/jobs/1/?utm_source=news',
        rawTitle: 'Backend Engineer',
        rawCompany: 'Acme PLC',
        rawDescription: 'Design and build services.',
        rawLocation: 'Addis Ababa',
        rawSalaryText: 'ETB 30,000 per month',
      }),
    );

    expect(job.canonicalUrl).toBe('https://example.com/jobs/1');
    expect(job.locationCategory).toBe('ADDIS_ABABA');
    expect(job.salary.type).toBe('EXACT');
    expect(job.salary.min).toBe('30000');
    expect(job.salary.currency).toBe('ETB');
    expect(job.salary.period).toBe('MONTH');
    expect(job.contentFingerprint).toBeTruthy();
  });

  it('records per-field provenance: SOURCE text vs DETERMINISTIC derivation', async () => {
    const adapter = new FakeSourceAdapter(makeFakeConfig());
    const job = await adapter.normalize(
      makeRawJob({
        sourceUrl: 'https://example.com/jobs/2',
        rawTitle: 'Data Analyst',
        rawLocation: 'Hawassa',
        rawSalaryText: 'Negotiable',
      }),
    );

    expect(job.provenance.title?.provenance).toBe('SOURCE');
    expect(job.provenance.canonicalUrl?.provenance).toBe('DETERMINISTIC');
    expect(job.provenance.locationCategory?.conversionMethod).toBe('LOCATION_GAZETTEER_V1');
    expect(job.provenance.salaryType?.provenance).toBe('DETERMINISTIC');
  });

  it('never fabricates: absent evidence stays UNKNOWN / null', async () => {
    const adapter = new FakeSourceAdapter(makeFakeConfig());
    const job = await adapter.normalize(makeRawJob());

    expect(job.canonicalUrl).toBeNull();
    expect(job.title).toBeNull();
    expect(job.company).toBeNull();
    expect(job.descriptionQuality).toBe('UNUSABLE');
    expect(job.locationCategory).toBe('UNKNOWN');
    expect(job.remoteStatus).toBe('UNKNOWN');
    expect(job.salary.type).toBe('UNKNOWN');
    expect(job.salary.min).toBeNull();
    expect(job.salary.max).toBeNull();
    expect(job.salary.currency).toBeNull();
    expect(job.publishedDate.calendar).toBe('UNKNOWN');
    expect(job.publishedDate.publishedAt).toBeNull();
    expect(job.employmentType).toBe('UNKNOWN');
    expect(job.application.method).toBe('UNKNOWN');
    expect(job.contentFingerprint).toBeNull();
    expect(job.provenance).toEqual({});
  });

  it('healthCheck uses the injected clock and reports the sample it saw', async () => {
    const adapter = new FakeSourceAdapter(makeFakeConfig(), [makeRawJob()]);
    const result = await adapter.healthCheck({ now: NOW, logger: silentWorkerLogger });

    expect(result.checkedAt).toBe(NOW);
    expect(result.sampleSize).toBe(1);
    expect(result.status).toBe('HEALTHY');
  });
});
