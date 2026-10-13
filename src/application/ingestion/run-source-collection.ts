import { SourceRunStatus, SourceRunTrigger } from '@domain/enums';
import { rawContentHash, resolveSourceRecordIdentity } from '@domain/normalizers';
import {
  SourceResultExpectation,
  isUnexpectedZeroResult,
  type NormalizedJob,
  type RawJobEvidence,
  type SourceRunRecord,
} from '@domain/types';
import type { JobRepository } from '@ports/job-repository';
import type { RawJobRepository } from '@ports/raw-job-repository';
import type { JobSourceAdapter } from '@ports/source-adapter';
import type { SourceRunOutcome, SourceRunRepository } from '@ports/source-run-repository';
import type { WorkerLogger } from '@ports/worker-logger';

/**
 * The collection use case: run one source once, end to end (SRS 7.7), recording the
 * SRS 7.8 funnel.
 *
 * Boundary discipline: the adapter acquires and interprets source content, this use
 * case owns persistence, identity and run accounting. Every fingerprint and every
 * identity key is computed here, in the domain, and *passed* to the repositories - a
 * repository never invents a fingerprint (ADR-0001).
 *
 * ## Sequence
 *
 * The literal SRS 7.7 numbering puts "acquire source content" (1) and "apply source
 * rate limits" (2) before "create SourceRun" (3). This use case opens the run *first*,
 * deliberately:
 *
 *   - SRS 7.6 requires source-level exclusivity for collection ("Source collection
 *     requires source-level exclusivity"). The run row is that lock, so it has to be
 *     taken before any network work, or two workers can collect one source at once.
 *   - `CollectionContext.sourceRunId` is required by the reviewed adapter port, so the
 *     adapter cannot even be called without a run.
 *   - An acquisition failure would otherwise leave no record at all, and the SRS 7.8
 *     "HTTP failures" metric could never be populated.
 *
 * The run is a plain row, never a long transaction: no transaction is held across the
 * network call or across records.
 *
 * Step 10 of the sequence ("schedule enrichment/matching work") is not performed here.
 * The enrichment and matching stages do not exist yet; enqueueing work for an
 * unregistered handler produces guaranteed permanent failures, which would be a worse
 * outcome than a documented gap.
 *
 * ## Isolation and crash safety
 *
 * One malformed record is counted (`parseFailures`), logged, and skipped - its raw
 * evidence is already persisted, so the evidence is never lost and the rest of the run
 * continues. Abandoned runs from a crashed worker are recovered by reaping stale runs
 * before the new run starts (ENG-025).
 */

/** Terminal run statuses this use case can record. */
export type TerminalRunStatus = SourceRunOutcome['status'];

/** Longest errorSummary, so one hostile record cannot fill the column. */
const MAX_ERROR_SUMMARY_LENGTH = 1000;

/** How many distinct per-record failure notes are retained in `errorSummary`. */
const MAX_RETAINED_FAILURE_NOTES = 5;

/**
 * Every SRS 7.8 funnel count the collection stage owns, plus the two identity outcomes
 * the ADR requires to be visible.
 *
 * The owned stages are `collected -> parsed -> valid -> unique`; the funnel continues
 * `active -> matched -> notified` outside collection.
 */
export interface CollectionFunnel {
  /** `collected`: records the adapter returned. */
  collected: number;
  /** `parsed`: records whose normalize completed without throwing. */
  parsed: number;
  /**
   * `valid`: records that passed collection-time validation. Currently always equal to
   * `parsed`, because the SRS defines no collection-time rejection rule - Appendix E is
   * explicit that a Job with an UNUSABLE description is persisted "for traceability and
   * funnel metrics". Kept explicit so the stage is not silently absent from the funnel.
   */
  valid: number;
  /** `unique`: records that created a Job. */
  unique: number;
  /** Records already stored under their resolved identity (refreshed, not created). */
  duplicates: number;
  /** Records preserved as evidence but not promoted, because no identity resolved. */
  undeduplicable: number;
  /** Records whose resolved identity rests on the weakest (`fp:`) basis. */
  fallbackIdentities: number;
  /** `normalize` threw for these records; their raw evidence is still preserved. */
  parseFailures: number;
  /** Acquisitions that failed, so there was nothing to parse. */
  httpFailures: number;
}

export interface RunSourceCollectionResult {
  /**
   * The run as recorded, or null when it was no longer active at finalize time - i.e.
   * it was reaped as stale, so this attempt's outcome was deliberately discarded
   * (the fenced finalizer).
   */
  run: SourceRunRecord | null;
  /** What this attempt observed, even when `run` is null. */
  funnel: CollectionFunnel;
  /** What this attempt recorded, or would have recorded. Equals `run.status` otherwise. */
  status: TerminalRunStatus;
  unexpectedZeroResults: boolean;
}

export interface RunSourceCollectionDeps {
  sourceRuns: SourceRunRepository;
  rawJobs: RawJobRepository;
  jobs: JobRepository;
  logger: WorkerLogger;
}

export interface RunSourceCollectionInput {
  /** The adapter for exactly one configured source. */
  adapter: JobSourceAdapter;
  /** Injected current time (ENG-012); adapters must not read the wall clock. */
  now: Date;
  /**
   * Runs still active after this many seconds are reaped as abandoned before this
   * attempt opens its own run (ENG-025). Required, because it is the safety bound that
   * makes a crashed attempt recoverable and a silent default would make the wedge
   * length an accident. It is not a run timeout: a live run is never reaped.
   */
  staleRunSeconds: number;
  /** Defaults to SCHEDULE. */
  trigger?: SourceRunTrigger;
  /**
   * Per-source declaration of whether results are expected (ADR-0001 section 4).
   * Defaults to UNKNOWN, which never raises the unexpected-zero-result signal.
   */
  resultExpectation?: SourceResultExpectation;
  /** Cooperative cancellation (worker shutdown). */
  signal?: AbortSignal;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message ? `${error.name}: ${error.message}` : error.name;
  }
  return String(error);
}

function bound(summary: string): string {
  return summary.length <= MAX_ERROR_SUMMARY_LENGTH
    ? summary
    : `${summary.slice(0, MAX_ERROR_SUMMARY_LENGTH - 3)}...`;
}

export class RunSourceCollection {
  constructor(private readonly deps: RunSourceCollectionDeps) {}

  async run(input: RunSourceCollectionInput): Promise<RunSourceCollectionResult> {
    const { adapter, signal } = input;
    const sourceId = adapter.config.sourceId;
    const expectation = input.resultExpectation ?? SourceResultExpectation.UNKNOWN;

    const funnel: CollectionFunnel = {
      collected: 0,
      parsed: 0,
      valid: 0,
      unique: 0,
      duplicates: 0,
      undeduplicable: 0,
      fallbackIdentities: 0,
      parseFailures: 0,
      httpFailures: 0,
    };
    const notes: string[] = [];

    // Recovery before contention: a run abandoned by a crashed worker would otherwise
    // hold the one-active-run lock forever and wedge the source (ENG-025, SRS 7.6).
    const reaped = await this.deps.sourceRuns.reapStaleRuns(input.staleRunSeconds);
    if (reaped.length > 0) {
      this.deps.logger.warn('reaped stale collection runs before starting', {
        sourceId,
        reapedRunIds: reaped.map((run) => run.id),
      });
    }

    // SourceRunActiveError is intentionally *not* handled here: it means a genuinely
    // live run holds the source, which is a real conflict the caller must respect
    // rather than work around (FR-003).
    const run = await this.deps.sourceRuns.start({
      sourceId,
      trigger: input.trigger,
    });

    let records: RawJobEvidence[];
    try {
      records = await adapter.collect({
        sourceRunId: run.id,
        now: input.now,
        signal,
        logger: this.deps.logger,
      });
    } catch (error) {
      if (signal?.aborted) {
        // Shutdown, not a source fault: no HTTP failure is claimed.
        return this.finish(run, funnel, {
          status: SourceRunStatus.PARTIAL,
          unexpectedZeroResults: false,
          errorSummary: 'collection aborted during acquisition (worker shutdown)',
        });
      }
      // The SRS has no separate "acquisition failed" metric; "HTTP failures" is the
      // closest SRS 7.8 metric, so exactly one failed acquisition is counted there and
      // the concrete error is kept verbatim rather than guessed at.
      funnel.httpFailures = 1;
      return this.finish(run, funnel, {
        status: SourceRunStatus.FAILED,
        unexpectedZeroResults: false,
        errorSummary: `source acquisition failed: ${describeError(error)}`,
      });
    }

    funnel.collected = records.length;
    let abortedAt: number | null = null;

    for (let index = 0; index < records.length; index += 1) {
      if (signal?.aborted) {
        abortedAt = index;
        break;
      }
      const record = records[index];

      // SRS 7.7 step 4: raw evidence is persisted *before* any downstream promotion, so
      // a failure later in the pipeline can never lose what the source published.
      const observed = await this.deps.rawJobs.observe({
        sourceId,
        sourceRunId: run.id,
        evidence: record,
        contentHash: rawContentHash({
          sourceUrl: record.sourceUrl,
          rawTitle: record.rawTitle,
          rawCompany: record.rawCompany,
          rawLocation: record.rawLocation,
          rawDescription: record.rawDescription,
          rawPublishedDateText: record.rawPublishedDateText,
          rawSalaryText: record.rawSalaryText,
        }),
      });

      let job: NormalizedJob;
      try {
        // SRS 7.7 steps 5-7 (normalize, extract, validate). The adapter delegates the
        // shared normalizer work (ENG-016).
        job = await adapter.normalize(record);
      } catch (error) {
        funnel.parseFailures += 1;
        if (notes.length < MAX_RETAINED_FAILURE_NOTES) {
          notes.push(`record ${index}: parse failed (${describeError(error)})`);
        }
        this.deps.logger.warn('record failed to normalize; raw evidence retained', {
          sourceId,
          runId: run.id,
          rawJobId: observed.rawJob.id,
          reason: describeError(error),
        });
        continue;
      }
      funnel.parsed += 1;
      // No collection-time rejection rule exists, so nothing is dropped here. An
      // UNUSABLE description is a matching concern, not a collection one (Appendix E).
      funnel.valid += 1;

      // SRS 7.7 step 8 (deduplicate). Identity is resolved from the raw record and the
      // source's declared policy, never from content equality (ADR-0001).
      const identity = resolveSourceRecordIdentity({
        job,
        stableSourceJobIdentifier: record.sourceJobIdentifier,
        policy: adapter.config,
      });

      if (identity.key === null) {
        funnel.undeduplicable += 1;
        this.deps.logger.warn('record has no reliable identity; evidence retained, not promoted', {
          sourceId,
          runId: run.id,
          rawJobId: observed.rawJob.id,
        });
        continue;
      }
      if (identity.basis === 'fallback') funnel.fallbackIdentities += 1;

      // SRS 7.7 step 9 (persist Job), scoped to this source.
      const upserted = await this.deps.jobs.upsert({
        sourceId,
        rawJobId: observed.rawJob.id,
        identityKey: identity.key,
        job,
      });
      if (upserted.isNew) funnel.unique += 1;
      else funnel.duplicates += 1;
    }

    const unexpectedZeroResults = isUnexpectedZeroResult(funnel.collected, expectation);

    let status: TerminalRunStatus;
    if (abortedAt !== null) {
      status = SourceRunStatus.PARTIAL;
      notes.push(`aborted after ${abortedAt} of ${records.length} records (worker shutdown)`);
    } else if (unexpectedZeroResults) {
      status = SourceRunStatus.PARTIAL;
      notes.push('source returned zero results but results were expected');
    } else if (funnel.parseFailures > 0) {
      // Partial: the run completed but some records could not be read. Their raw
      // evidence is preserved, so this is a data-quality signal, not a failure.
      status = SourceRunStatus.PARTIAL;
    } else {
      status = SourceRunStatus.SUCCEEDED;
    }

    return this.finish(run, funnel, {
      status,
      unexpectedZeroResults,
      errorSummary: notes.length === 0 ? null : bound(notes.join('; ')),
    });
  }

  private async finish(
    run: SourceRunRecord,
    funnel: CollectionFunnel,
    outcome: {
      status: TerminalRunStatus;
      unexpectedZeroResults: boolean;
      errorSummary: string | null;
    },
  ): Promise<RunSourceCollectionResult> {
    const recorded: SourceRunOutcome = {
      status: outcome.status,
      jobsDiscovered: funnel.collected,
      jobsAccepted: funnel.unique,
      jobsDuplicate: funnel.duplicates,
      jobsRejected: 0,
      undeduplicable: funnel.undeduplicable,
      fallbackIdentities: funnel.fallbackIdentities,
      parseFailures: funnel.parseFailures,
      httpFailures: funnel.httpFailures,
      unexpectedZeroResults: outcome.unexpectedZeroResults,
      errorSummary: outcome.errorSummary,
    };

    const finalized = await this.deps.sourceRuns.finalize(run.id, recorded);
    if (finalized === null) {
      this.deps.logger.warn('run was no longer active when it finished; outcome discarded', {
        sourceId: run.sourceId,
        runId: run.id,
        intendedStatus: outcome.status,
      });
    }

    return {
      run: finalized,
      funnel,
      status: outcome.status,
      unexpectedZeroResults: outcome.unexpectedZeroResults,
    };
  }
}
