import { SourceRunStatus, SourceRunTrigger } from '@domain/enums';
import type { JobSourceAdapter } from '@ports/source-adapter';
import { SourceRunActiveError } from '@ports/source-run-repository';
import type { WorkerLogger } from '@ports/worker-logger';
import {
  DeferredWorkTaskError,
  PermanentWorkTaskError,
  describeError,
  type WorkTaskHandler,
} from '@application/worker';
import { RunSourceCollection, type RunSourceCollectionResult } from './run-source-collection';

/**
 * Work task type that runs one source collection (SRS 7.7). The scheduler enqueues it and
 * the handler below consumes it; both import this constant so the type cannot drift.
 */
export const SOURCE_COLLECTION_TASK_TYPE = 'source.collect';

/**
 * Dedupe key for a source's collection task. Active-only uniqueness (the
 * `one_active_task_per_dedupe_key` partial index) then guarantees at most one pending or
 * running collection per source — the queue-level half of the SRS 7.5 source exclusivity
 * that the `one_active_run_per_source` index enforces at run level.
 */
export function sourceCollectionDedupeKey(sourceId: string): string {
  return `${SOURCE_COLLECTION_TASK_TYPE}:${sourceId}`;
}

export interface SourceCollectionTaskPayload {
  sourceId: string;
  /** Why the run was triggered; carried so a catch-up run is recorded as STARTUP (SRS 7.6). */
  trigger: SourceRunTrigger;
}

const VALID_TRIGGERS = new Set<string>(Object.values(SourceRunTrigger));

/**
 * Extra wait beyond the stale window before a deferred collection is retried. The window is
 * measured from the abandoned run's last liveness report, which is at or before the moment this
 * attempt was deferred (a run that is still reporting is not abandoned, and a worker that stopped
 * reporting did so no later than now), so the run is reapable when the delay elapses. The margin
 * only covers the poll interval between the task becoming due and a worker claiming it.
 */
const STALE_WINDOW_GRACE_SECONDS = 30;

/**
 * Validate an untrusted task payload. A malformed payload is a permanent failure: retrying it
 * unchanged can never succeed.
 */
export function parseSourceCollectionTaskPayload(payload: unknown): SourceCollectionTaskPayload {
  const value = payload as { sourceId?: unknown; trigger?: unknown } | null;
  const sourceId = value?.sourceId;
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new PermanentWorkTaskError('source collection task payload requires a sourceId');
  }
  const trigger = value?.trigger ?? SourceRunTrigger.SCHEDULE;
  if (typeof trigger !== 'string' || !VALID_TRIGGERS.has(trigger)) {
    throw new PermanentWorkTaskError(
      `source collection task payload has an invalid trigger: ${String(trigger)}`,
    );
  }
  return { sourceId, trigger: trigger as SourceRunTrigger };
}

export interface SourceCollectionHandlerOptions {
  /**
   * Builds the adapter for a source, or returns null when none is configured. The resolver is
   * injected so this handler stays free of source-specific knowledge (ENG-016): production
   * supplies a real adapter factory, tests supply the fake adapter.
   */
  resolveAdapter: (sourceId: string) => Promise<JobSourceAdapter | null>;
  collection: RunSourceCollection;
  /** Upper bound on a single acquisition, forwarded to `RunSourceCollection` (ENG-031). */
  acquisitionTimeoutMs: number;
  /** Safety bound for abandoned runs, forwarded to `RunSourceCollection` (ENG-025). */
  staleRunSeconds: number;
  /**
   * How often the run in flight restates that it is still working, forwarded to
   * `RunSourceCollection` (audit M2). Absent means the use case's own default.
   */
  sourceRunHeartbeatMs?: number;
  /**
   * Post-collection lifecycle sweep (FR-019). Called only after a run that finished
   * `SUCCEEDED` and made a coverage claim — read the listing to the end, or at least read a
   * dated window of it. Every other run says nothing about what it did not see. Absent means
   * the sweep never runs.
   */
  sweep?: (sourceId: string) => Promise<{ retired: number; restored: number; examined: number }>;
  /** Optional logger for the sweep outcome; absent means silent. */
  logger?: WorkerLogger;
  /** Injected clock (ENG-012). Defaults to the wall clock. */
  now?: () => Date;
}

/**
 * Handler for {@link SOURCE_COLLECTION_TASK_TYPE}: resolve the source's adapter and run one
 * collection. A source with no adapter is a permanent failure (retrying cannot conjure one);
 * every other error is classified by the worker.
 */
export function createSourceCollectionHandler(
  options: SourceCollectionHandlerOptions,
): WorkTaskHandler {
  const now = options.now ?? (() => new Date());
  return async ({ task, signal }) => {
    const { sourceId, trigger } = parseSourceCollectionTaskPayload(task.payload);
    const adapter = await options.resolveAdapter(sourceId);
    if (adapter === null) {
      throw new PermanentWorkTaskError(`no adapter is configured for source ${sourceId}`);
    }
    let result: RunSourceCollectionResult;
    try {
      result = await options.collection.run({
        adapter,
        now: now(),
        trigger,
        staleRunSeconds: options.staleRunSeconds,
        acquisitionTimeoutMs: options.acquisitionTimeoutMs,
        heartbeatMs: options.sourceRunHeartbeatMs,
        // The source's own approved declaration (Appendix E), not a pipeline default: a source
        // approved as RESULTS_EXPECTED must report an empty listing (AC-018) instead of
        // recording a clean run. Absent means UNKNOWN, which never raises the signal.
        resultExpectation: adapter.config.resultExpectation,
        signal,
      });
    } catch (error) {
      if (!(error instanceof SourceRunActiveError)) throw error;
      // Another run holds this source. That is not a failure of this task: the run may be a
      // live collection that will finish on its own, or one abandoned by a crashed worker
      // that the next attempt reaps. But it is only reapable after the stale window, and the
      // whole retry budget is spent in about two minutes, so failing here would dead-letter
      // the task and idle the source until its next 3h/6h schedule (H3). Wait for the
      // window instead, without consuming an attempt.
      throw new DeferredWorkTaskError(
        `source ${sourceId} is held by a run that is not yet reapable; ` +
          `retrying after the ${options.staleRunSeconds}s stale window`,
        options.staleRunSeconds + STALE_WINDOW_GRACE_SECONDS,
        { cause: error },
      );
    }

    // FR-019: reconcile lifecycles against this run's coverage. Only a SUCCEEDED run that
    // made a coverage claim may retire anything; every other run says nothing about what it
    // did not see. A sweep failure must not turn a good run into a retried task — the
    // collection data is durable and the next covered run sweeps again.
    if (
      options.sweep &&
      result.run !== null &&
      result.status === SourceRunStatus.SUCCEEDED &&
      (result.run.catalogueExhausted || result.run.oldestListingPublishedAt !== null)
    ) {
      try {
        const swept = await options.sweep(result.run.sourceId);
        if (swept.retired > 0 || swept.restored > 0) {
          options.logger?.info('lifecycle sweep retired stale jobs', {
            sourceId,
            runId: result.run.id,
            retired: swept.retired,
            restored: swept.restored,
            examined: swept.examined,
          });
        }
      } catch (error) {
        options.logger?.warn('lifecycle sweep failed after a complete collection', {
          sourceId,
          runId: result.run.id,
          error: describeError(error),
        });
      }
    }
  };
}
