import {
  DescriptionQuality,
  SourceRunStatus,
  SourceRunTrigger,
} from '@domain/enums';
import { DESCRIPTION_QUALITY_VERSION } from '@domain/normalizers';
import { RunSourceCollection } from '@application/ingestion/run-source-collection';
import type { NormalizedJob, RawJobEvidence, SourceRunRecord } from '@domain/types';
import type { JobRepository, UpsertJobInput, UpsertJobResult } from '@ports/job-repository';
import type {
  ObserveRawJobInput,
  ObserveRawJobResult,
  RawJobRecord,
  RawJobRepository,
} from '@ports/raw-job-repository';
import type { JobSourceAdapter } from '@ports/source-adapter';
import type {
  SourceRunOutcome,
  SourceRunRepository,
} from '@ports/source-run-repository';
import { silentWorkerLogger } from '@ports/worker-logger';
import { FakeSourceAdapter, makeFakeConfig, makeRawJob } from '../support/fake-source-adapter';

/**
 * FR-007 authority at the pipeline boundary: `RunSourceCollection` must re-derive
 * `descriptionQuality` from the description it is about to persist, so an adapter cannot
 * promote or downgrade it. The repositories are in-memory stubs so this runs without a
 * database and isolates the pipeline decision from persistence.
 */

const NOW = new Date('2026-10-16T00:00:00.000Z');

const RUN: SourceRunRecord = {
  id: '00000000-0000-0000-0000-0000000000aa',
  sourceId: '00000000-0000-0000-0000-000000000001',
  status: SourceRunStatus.RUNNING,
  trigger: SourceRunTrigger.SCHEDULE,
  startedAt: NOW,
  finishedAt: null,
  durationMs: null,
  jobsDiscovered: 0,
  jobsAccepted: 0,
  jobsDuplicate: 0,
  jobsRejected: 0,
  undeduplicable: 0,
  fallbackIdentities: 0,
  parseFailures: 0,
  httpFailures: 0,
  unexpectedZeroResults: false,
  enrichmentScheduled: false,
  errorSummary: null,
};

class StubSourceRuns implements SourceRunRepository {
  lastOutcome: SourceRunOutcome | null = null;

  async start(): Promise<SourceRunRecord> {
    return RUN;
  }

  async finalize(_runId: string, outcome: SourceRunOutcome): Promise<SourceRunRecord> {
    this.lastOutcome = outcome;
    return RUN;
  }

  async reapStaleRuns(): Promise<SourceRunRecord[]> {
    return [];
  }

  async findById(): Promise<SourceRunRecord | null> {
    return RUN;
  }
}

class StubRawJobs implements RawJobRepository {
  readonly saved: RawJobRecord[] = [];

  async observe(input: ObserveRawJobInput): Promise<ObserveRawJobResult> {
    const record: RawJobRecord = {
      id: `raw-${this.saved.length + 1}`,
      sourceId: input.sourceId,
      sourceRunId: input.sourceRunId ?? null,
      sourceJobIdentifier: input.evidence.sourceJobIdentifier,
      sourceUrl: input.evidence.sourceUrl,
      rawTitle: input.evidence.rawTitle,
      rawCompany: input.evidence.rawCompany,
      rawLocation: input.evidence.rawLocation,
      rawDescription: input.evidence.rawDescription,
      rawPublishedDateText: input.evidence.rawPublishedDateText,
      rawSalaryText: input.evidence.rawSalaryText,
      contentHash: input.contentHash,
      collectedAt: NOW,
      lastSeenAt: NOW,
      createdAt: NOW,
    };
    this.saved.push(record);
    return { rawJob: record, isNewObservation: true };
  }

  async findById(id: string): Promise<RawJobRecord | null> {
    return this.saved.find((row) => row.id === id) ?? null;
  }

  async listForSourceRecord(): Promise<RawJobRecord[]> {
    return this.saved;
  }
}

class StubJobs implements JobRepository {
  readonly upserted: UpsertJobInput[] = [];

  async upsert(input: UpsertJobInput): Promise<UpsertJobResult> {
    this.upserted.push(input);
    return {
      job: {
        id: `job-${this.upserted.length}`,
        sourceId: input.sourceId,
        rawJobId: input.rawJobId ?? null,
        identityKey: input.identityKey,
        canonicalUrl: input.job.canonicalUrl,
        title: input.job.title,
        company: input.job.company,
        description: input.job.description,
        descriptionQuality: input.job.descriptionQuality,
        locationText: input.job.locationText,
        contentFingerprint: input.job.contentFingerprint,
        publishedAt: input.job.publishedDate.publishedAt,
        createdAt: NOW,
        updatedAt: NOW,
      },
      isNew: true,
    };
  }

  async findById(): Promise<null> {
    return null;
  }

  async countForSource(): Promise<number> {
    return this.upserted.length;
  }

  async listLifecycleCandidates(): Promise<[]> {
    return [];
  }

  async applyLifecycleStatuses(): Promise<number> {
    return 0;
  }
}

/** A real adapter shape whose `descriptionQuality` is a lie the pipeline must ignore. */
class LyingAdapter implements JobSourceAdapter {
  readonly config = makeFakeConfig();
  private readonly honest = new FakeSourceAdapter(this.config);
  readonly rows: RawJobEvidence[];

  constructor(rows: RawJobEvidence[], private readonly lie: DescriptionQuality) {
    this.rows = rows;
  }

  async collect(): Promise<RawJobEvidence[]> {
    return this.rows.map((row) => ({ ...row }));
  }

  async normalize(raw: RawJobEvidence): Promise<NormalizedJob> {
    const job = await this.honest.normalize(raw);
    return { ...job, descriptionQuality: this.lie };
  }

  async healthCheck(): Promise<never> {
    throw new Error('healthCheck is not exercised by the collection pipeline');
  }
}

function harness() {
  const sourceRuns = new StubSourceRuns();
  const rawJobs = new StubRawJobs();
  const jobs = new StubJobs();
  const collection = new RunSourceCollection({ sourceRuns, rawJobs, jobs, logger: silentWorkerLogger });
  return { sourceRuns, rawJobs, jobs, collection };
}

async function collectOnce(adapter: LyingAdapter) {
  const h = harness();
  const result = await h.collection.run({
    adapter,
    now: NOW,
    staleRunSeconds: 60,
    acquisitionTimeoutMs: 1_000,
  });
  return { ...h, result };
}

describe('RunSourceCollection is authoritative for descriptionQuality (FR-007)', () => {
  it('overwrites an adapter that promotes an actually UNUSABLE description', async () => {
    const { jobs, rawJobs } = await collectOnce(
      new LyingAdapter(
        [makeRawJob({ sourceJobIdentifier: 'x-1', rawTitle: 'Engineer', rawDescription: '\u200B' })],
        DescriptionQuality.SUFFICIENT,
      ),
    );

    expect(jobs.upserted).toHaveLength(1);
    expect(jobs.upserted[0].job.descriptionQuality).toBe(DescriptionQuality.UNUSABLE);
    // Raw evidence is retained, so the record can be reprocessed later.
    expect(rawJobs.saved[0].rawDescription).toBe('\u200B');
  });

  it('overwrites an adapter that downgrades real prose', async () => {
    const sufficient = Array.from({ length: 30 }, (_, i) => `responsibility${i}`).join(' ');
    const { jobs } = await collectOnce(
      new LyingAdapter(
        [
          makeRawJob({
            sourceJobIdentifier: 'x-2',
            rawTitle: 'Engineer',
            rawDescription: sufficient,
          }),
        ],
        DescriptionQuality.UNUSABLE,
      ),
    );

    expect(jobs.upserted[0].job.descriptionQuality).toBe(DescriptionQuality.SUFFICIENT);
  });

  it('records the shared policy version in provenance, replacing the adapter claim', async () => {
    const { jobs } = await collectOnce(
      new LyingAdapter(
        [makeRawJob({ sourceJobIdentifier: 'x-3', rawTitle: 'Engineer', rawDescription: '' })],
        DescriptionQuality.SUFFICIENT,
      ),
    );

    expect(jobs.upserted[0].job.provenance.descriptionQuality).toMatchObject({
      provenance: 'DETERMINISTIC',
      conversionMethod: DESCRIPTION_QUALITY_VERSION,
    });
  });

  it('still persists the UNUSABLE Job and counts nothing as rejected', async () => {
    const { jobs, result } = await collectOnce(
      new LyingAdapter(
        [makeRawJob({ sourceJobIdentifier: 'x-4', rawTitle: 'Engineer', rawDescription: 'Apply' })],
        DescriptionQuality.SUFFICIENT,
      ),
    );

    expect(jobs.upserted[0].job.descriptionQuality).toBe(DescriptionQuality.UNUSABLE);
    expect(result.funnel).toMatchObject({ collected: 1, parsed: 1, valid: 1, unique: 1 });
    expect(result.run).toMatchObject({ jobsRejected: 0 });
  });
});
