import { SourceRunTrigger } from '@domain/enums';
import type { JobSourceAdapter } from '@ports/source-adapter';
import { PermanentWorkTaskError, type WorkTaskHandler } from '@application/worker';
import { RunSourceCollection } from './run-source-collection';

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
  /** Safety bound for abandoned runs, forwarded to `RunSourceCollection` (ENG-025). */
  staleRunSeconds: number;
  /** Upper bound on a single acquisition, forwarded to `RunSourceCollection` (ENG-031). */
  acquisitionTimeoutMs: number;
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
    await options.collection.run({
      adapter,
      now: now(),
      trigger,
      staleRunSeconds: options.staleRunSeconds,
      acquisitionTimeoutMs: options.acquisitionTimeoutMs,
      // The source's own approved declaration (Appendix E), not a pipeline default: a source
      // approved as RESULTS_EXPECTED must report an empty listing (AC-018) instead of
      // recording a clean run. Absent means UNKNOWN, which never raises the signal.
      resultExpectation: adapter.config.resultExpectation,
      signal,
    });
  };
}
