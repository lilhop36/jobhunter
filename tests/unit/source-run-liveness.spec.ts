import { describe, expect, it } from 'vitest';
import {
  HealthStatus,
  SourceRunStatus,
  SourceRunTrigger,
  WorkTaskStatus,
} from '@domain/enums';
import {
  DEFAULT_SOURCE_RUN_HEARTBEAT_MS,
  SourceResultExpectation,
  resolveSourceRunHeartbeatMs,
  type RawJobEvidence,
  type SourceRunRecord,
  type WorkTaskRecord,
} from '@domain/types';
import { RunSourceCollection } from '@application/ingestion/run-source-collection';
import type {
  SourceHealthConsequence,
  SourceRunOutcome,
  SourceRunRepository,
  SourceRunYieldSample,
} from '@ports/source-run-repository';
import type {
  ObserveRawJobInput,
  ObserveRawJobResult,
  RawJobRecord,
  RawJobRepository,
} from '@ports/raw-job-repository';
import type { JobRepository, UpsertJobInput, UpsertJobResult } from '@ports/job-repository';
import type { EnqueueWorkTaskInput, WorkTaskRepository } from '@ports/work-task-repository';
import { silentWorkerLogger } from '@ports/worker-logger';
import { FakeSourceAdapter, makeFakeConfig, makeRawJob } from '../support/fake-source-adapter';

/**
 * A run's liveness while it writes (audit M2).
 *
 * The finding was that `startedAt` was the only evidence the recovery sweep had, so a collection
 * that took longer than the stale window could be reclaimed *while it was working*: its source
 * was unlocked, a replacement run started, and this attempt's counters, health and coverage
 * claim were thrown away by the fenced finalizer - while the loop kept writing, because it
 * watched only the worker-shutdown signal. These cases pin both halves of the fix: the run
 * reports itself as it goes, and a report that comes back "that run is gone" makes it stop.
 */

const NOW = new Date('2026-10-31T00:00:00.000Z');
const STALE_RUN_SECONDS = 900;

/** One beat per record: what these tests are about is the reporting, not its spacing. */
const HEARTBEAT_MS = 1;

/** Long enough per record that a 1 ms interval has certainly elapsed by the next one. */
const RECORD_COST_MS = 2;

const RUN_ID = 'run-liveness';

class LivenessSourceRuns implements SourceRunRepository {
  readonly heartbeatCalls: string[] = [];
  lastOutcome: SourceRunOutcome | null = null;
  lastHealth: SourceHealthConsequence | null | undefined;

  /** A report beyond the n-th answers "no longer yours"; 0 means every report succeeds. */
  refuseBeatAfter = 0;
  /** Throw instead of returning false: an unreadable answer, which is not evidence of death. */
  heartbeatThrows = false;

  private active = true;

  private readonly run: SourceRunRecord = {
    id: RUN_ID,
    sourceId: makeFakeConfig().sourceId,
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
    catalogueExhausted: false,
    oldestListingPublishedAt: null,
    enrichmentScheduled: false,
    lastHeartbeatAt: NOW,
    errorSummary: null,
  };

  async start(): Promise<SourceRunRecord> {
    return this.run;
  }

  async heartbeat(runId: string): Promise<boolean> {
    this.heartbeatCalls.push(runId);
    if (this.heartbeatThrows) throw new Error('connection reset by peer');
    if (this.refuseBeatAfter !== 0 && this.heartbeatCalls.length > this.refuseBeatAfter) {
      // The sweep got there first. The row is terminal, so nothing this attempt writes next
      // belongs to a live run any more.
      this.active = false;
      return false;
    }
    return this.active;
  }

  async finalize(
    _runId: string,
    outcome: SourceRunOutcome,
    health: SourceHealthConsequence | null,
  ): Promise<SourceRunRecord | null> {
    this.lastOutcome = outcome;
    this.lastHealth = health;
    // The fenced finalizer: a reclaimed run records nothing at all, health included.
    if (!this.active) return null;
    return { ...this.run, status: outcome.status, finishedAt: NOW };
  }

  async reapStaleRuns(): Promise<SourceRunRecord[]> {
    return [];
  }

  async recentCleanYields(): Promise<SourceRunYieldSample[]> {
    return [];
  }

  async findById(): Promise<SourceRunRecord | null> {
    return this.run;
  }
}

/** Records what reached storage, so "stopped writing" is observable rather than asserted away. */
class CountingRawJobs implements RawJobRepository {
  readonly saved: string[] = [];

  async observe(input: ObserveRawJobInput): Promise<ObserveRawJobResult> {
    await new Promise((resolve) => setTimeout(resolve, RECORD_COST_MS));
    const id = `raw-${this.saved.length + 1}`;
    const record: RawJobRecord = {
      id,
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
    this.saved.push(id);
    return { rawJob: record, isNewObservation: true };
  }

  async findById(): Promise<RawJobRecord | null> {
    return null;
  }

  async listForSourceRecord(): Promise<RawJobRecord[]> {
    return [];
  }
}

class CountingJobs implements JobRepository {
  readonly saved: string[] = [];

  async upsert(input: UpsertJobInput): Promise<UpsertJobResult> {
    this.saved.push(input.identityKey);
    return {
      job: {
        id: `job-${this.saved.length}`,
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
    return this.saved.length;
  }

  async listLifecycleCandidates(): Promise<never[]> {
    return [];
  }

  async listDeadlineCandidates(): Promise<never[]> {
    return [];
  }

  async applyLifecycleStatuses(): Promise<number> {
    return 0;
  }
}

/**
 * The queue, as far as this suite is concerned: the only thing the use case does with it is the
 * SRS 7.7 step 10 hand-off, so that is the only method modelled.
 */
class HandoffOnlyTasks implements WorkTaskRepository {
  readonly enqueued: EnqueueWorkTaskInput[] = [];

  async enqueue(input: EnqueueWorkTaskInput): Promise<WorkTaskRecord> {
    this.enqueued.push(input);
    return {
      id: `task-${this.enqueued.length}`,
      type: input.type,
      payload: input.payload ?? null,
      dedupeKey: input.dedupeKey ?? null,
      status: WorkTaskStatus.PENDING,
      priority: input.priority ?? 0,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 5,
      runAfter: NOW,
      lockedAt: null,
      lockedBy: null,
      leaseToken: null,
      leaseExpiresAt: null,
      sourceRunId: null,
      lastError: null,
      lastErrorAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: null,
      finishedAt: null,
    };
  }

  async enqueueOrConflict(): Promise<never> {
    return this.unused();
  }

  async claim(): Promise<never> {
    return this.unused();
  }

  async heartbeat(): Promise<never> {
    return this.unused();
  }

  async complete(): Promise<never> {
    return this.unused();
  }

  async fail(): Promise<never> {
    return this.unused();
  }

  async defer(): Promise<never> {
    return this.unused();
  }

  async reapExpiredLeases(): Promise<never> {
    return this.unused();
  }

  private unused(): never {
    throw new Error('this suite does not exercise the queue beyond the step 10 hand-off');
  }
}

function records(count: number): RawJobEvidence[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeRawJob({
      sourceUrl: `https://source.example/job-${index}`,
      sourceJobIdentifier: `job-${index}`,
      rawTitle: `Engineer ${index}`,
    }),
  );
}

function stubCollection(count: number, coverageFloor?: Date) {
  const sourceRuns = new LivenessSourceRuns();
  const rawJobs = new CountingRawJobs();
  const jobs = new CountingJobs();
  const tasks = new HandoffOnlyTasks();
  const collection = new RunSourceCollection({
    sourceRuns,
    rawJobs,
    jobs,
    tasks,
    logger: silentWorkerLogger,
  });
  // With a coverage floor the run has a window claim to lose, so "the claim was withheld" is a
  // real assertion rather than one that passes because there was nothing to withhold.
  const adapter = new FakeSourceAdapter(
    makeFakeConfig(),
    records(count),
    coverageFloor === undefined,
    coverageFloor ?? null,
  );

  return {
    sourceRuns,
    rawJobs,
    jobs,
    tasks,
    adapter,
    collect: () =>
      collection.run({
        adapter,
        now: NOW,
        staleRunSeconds: STALE_RUN_SECONDS,
        acquisitionTimeoutMs: 30_000,
        heartbeatMs: HEARTBEAT_MS,
        // The source is not being judged for emptiness here; only its liveness is.
        resultExpectation: SourceResultExpectation.ZERO_EXPECTED,
      }),
  };
}

describe('a collection run reports itself as it works', () => {
  it('heartbeats between records and completes when every report succeeds', async () => {
    const harness = stubCollection(5);

    const result = await harness.collect();

    expect(result.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(harness.rawJobs.saved).toHaveLength(5);
    expect(harness.sourceRuns.heartbeatCalls.length).toBeGreaterThanOrEqual(5);
    expect(new Set(harness.sourceRuns.heartbeatCalls)).toEqual(new Set([RUN_ID]));
    expect(harness.sourceRuns.lastOutcome?.jobsDiscovered).toBe(5);
  });

  it('starts reporting before the first record, not one interval in', async () => {
    // A slow acquisition has already spent part of the stale window by the time the loop opens, so
    // a run that waited a whole interval for its first beat could be reclaimed before it ever
    // proved it was working - which is the failure this column exists to remove.
    const harness = stubCollection(1);

    await harness.collect();

    expect(harness.sourceRuns.heartbeatCalls).toEqual([RUN_ID]);
  });

  it('keeps going when a report cannot be written', async () => {
    // A database hiccup is not evidence that the run died - the worker is demonstrably here,
    // doing this work. Only a definitive "that run is not yours" may stop the loop.
    const harness = stubCollection(4);
    harness.sourceRuns.heartbeatThrows = true;

    const result = await harness.collect();

    expect(result.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(harness.rawJobs.saved).toHaveLength(4);
    expect(harness.sourceRuns.lastHealth).not.toBeNull();
  });
});

describe('a reclaimed run stops writing', () => {
  it('stops at the record whose report says the run is gone', async () => {
    const harness = stubCollection(6);
    harness.sourceRuns.refuseBeatAfter = 2;

    const result = await harness.collect();

    // Two records were written before the refusal; the remaining four never reach storage.
    expect(harness.sourceRuns.heartbeatCalls).toHaveLength(3);
    expect(harness.rawJobs.saved).toHaveLength(2);
    expect(harness.jobs.saved).toHaveLength(2);
    expect(result.status).toBe(SourceRunStatus.PARTIAL);
    // The outcome this attempt wanted to record was discarded, exactly as the fenced finalizer
    // requires - the row it belongs to is already terminal.
    expect(result.run).toBeNull();
  });

  it('withholds every claim about the source, because the sweep already decided', async () => {
    const harness = stubCollection(4, new Date('2026-10-20T00:00:00.000Z'));
    harness.sourceRuns.refuseBeatAfter = 2;

    await harness.collect();

    // A worker going away is not the source misbehaving, and a run that stopped halfway through
    // its listing cannot claim it read the whole thing. All three are withheld.
    expect(harness.sourceRuns.lastHealth).toBeNull();
    expect(harness.sourceRuns.lastOutcome?.catalogueExhausted).toBe(false);
    expect(harness.sourceRuns.lastOutcome?.oldestListingPublishedAt).toBeNull();
    expect(harness.sourceRuns.lastOutcome?.status).toBe(SourceRunStatus.PARTIAL);
    expect(harness.sourceRuns.lastOutcome?.errorSummary).toContain('reclaimed');
  });

  it('still hands the records it really wrote to matching', async () => {
    // The jobs are durable, whoever wrote them, and the scoring task is idempotent: an extra
    // pass costs less than jobs that sit unmatched until the next collection.
    const harness = stubCollection(4);
    harness.sourceRuns.refuseBeatAfter = 2;

    await harness.collect();

    expect(harness.tasks.enqueued).toHaveLength(1);
    expect(harness.sourceRuns.lastOutcome?.enrichmentScheduled).toBe(true);
  });

  it('never reclaims a run whose reports are landing', async () => {
    // The positive control. Without it, a suite in which the run is always refused would look
    // identical to one in which the reporting never happened.
    const harness = stubCollection(4);

    const result = await harness.collect();

    expect(result.status).toBe(SourceRunStatus.SUCCEEDED);
    expect(harness.sourceRuns.lastHealth).not.toBeNull();
    expect(harness.sourceRuns.lastHealth?.status).toBe(HealthStatus.HEALTHY);
  });
});

describe('resolveSourceRunHeartbeatMs', () => {
  it('takes the default when the caller has no interval', () => {
    // The default is a ceiling, not a promise: it adapts to a window shorter than itself, so a
    // live run always gets to report before it can be presumed dead.
    expect(resolveSourceRunHeartbeatMs(900)).toBe(DEFAULT_SOURCE_RUN_HEARTBEAT_MS);
    expect(resolveSourceRunHeartbeatMs(4)).toBe(2_000);
  });

  it('honours an interval that fits inside the stale window', () => {
    expect(resolveSourceRunHeartbeatMs(900, 15_000)).toBe(15_000);
    expect(resolveSourceRunHeartbeatMs(900, 899_999)).toBe(899_999);
  });

  it('refuses an interval that cannot report before the window closes', () => {
    // Silence, not age, is what the sweep reaps on; a beat that cannot land inside the window
    // would let a working run be reclaimed. Refusing is the only honest answer.
    expect(() => resolveSourceRunHeartbeatMs(60, 60_000)).toThrow(RangeError);
    expect(() => resolveSourceRunHeartbeatMs(60, 120_000)).toThrow(RangeError);
    expect(() => resolveSourceRunHeartbeatMs(60, 60_000)).toThrow(/stale window/);
  });

  it('refuses an interval that is not a positive number of milliseconds', () => {
    expect(() => resolveSourceRunHeartbeatMs(60, 0)).toThrow(RangeError);
    expect(() => resolveSourceRunHeartbeatMs(60, -1)).toThrow(RangeError);
    expect(() => resolveSourceRunHeartbeatMs(60, Number.NaN)).toThrow(RangeError);
  });

  it('refuses a stale window that is not a positive number of seconds', () => {
    // Not a heartbeat question, but the same arithmetic: against a window of zero, an interval
    // "shorter than it" cannot exist.
    expect(() => resolveSourceRunHeartbeatMs(0)).toThrow(RangeError);
    expect(() => resolveSourceRunHeartbeatMs(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
