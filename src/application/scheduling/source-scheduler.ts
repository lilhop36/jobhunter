import { SourceRunTrigger } from '@domain/enums';
import { parseScheduleInterval } from '@domain/scheduling/schedule-interval';
import type { JobSourceRepository } from '@ports/job-source-repository';
import type { SourceRunRepository } from '@ports/source-run-repository';
import type { WorkTaskRepository } from '@ports/work-task-repository';
import { consoleWorkerLogger, WorkerLogger } from '@ports/worker-logger';
import { describeError } from '@application/worker';
import {
  SOURCE_COLLECTION_TASK_TYPE,
  SourceCollectionTaskPayload,
  sourceCollectionDedupeKey,
} from '@application/ingestion';

export interface SourceSchedulerOptions {
  /** How often to re-evaluate due sources. Default 30s. */
  intervalMs?: number;
  /**
   * An active run older than this many seconds is abandoned and is reaped before the
   * scheduler enqueues any work (SRS 7.6; see `SourceRunRepository.reapStaleRuns`). Required,
   * with no default, so the recovery bound cannot become an accident.
   */
  staleRunSeconds: number;
}

interface ResolvedOptions {
  intervalMs: number;
  staleRunSeconds: number;
}

export interface SchedulerPassResult {
  /** Source ids newly enqueued this pass. */
  enqueued: string[];
  /** Source ids whose schedule is present but unparseable; these are never scheduled. */
  invalidSchedules: string[];
  /** Abandoned runs recovered before enqueuing (SRS 7.6). */
  reapedRuns: number;
}

export interface SourceSchedulerDeps {
  sources: JobSourceRepository;
  sourceRuns: SourceRunRepository;
  tasks: WorkTaskRepository;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive, finite number; received ${String(value)}`);
  }
  return value;
}

function resolveOptions(options: SourceSchedulerOptions): ResolvedOptions {
  return {
    intervalMs: positive(options.intervalMs ?? 30_000, 'intervalMs'),
    staleRunSeconds: positive(options.staleRunSeconds, 'staleRunSeconds'),
  };
}

/** Abort-aware sleep, so `stop()` does not wait out a full interval. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Enqueues collection work for sources whose schedule is due (FR-002, SRS 7.6).
 *
 * It does not collect anything itself: it persists one durable work task per due source and
 * lets the worker run it. That keeps a scheduler tick fast and crash-safe — a task enqueued
 * just before a restart is still there afterwards.
 *
 * Catch-up (SRS 7.6) falls out of how due-ness is computed: the next run is due at
 * `lastAttemptAt + interval`, read from persisted state, so a run missed while the worker was
 * offline is due on the next pass. `start()` runs one catch-up pass with the STARTUP trigger,
 * then a periodic pass with SCHEDULE. A missed window produces exactly one catch-up run, never
 * one per skipped interval, and the active-only dedupe key keeps at most one collection queued
 * per source (SRS 7.5).
 */
export class SourceScheduler {
  private readonly options: ResolvedOptions;
  private started = false;
  private controller?: AbortController;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly deps: SourceSchedulerDeps,
    options: SourceSchedulerOptions,
    private readonly logger: WorkerLogger = consoleWorkerLogger,
  ) {
    this.options = resolveOptions(options);
  }

  /**
   * One pass: recover abandoned runs, then enqueue a collection for every due source.
   * `runOnce(now, STARTUP)` is the startup catch-up pass.
   */
  async runOnce(
    now: Date,
    trigger: SourceRunTrigger = SourceRunTrigger.SCHEDULE,
  ): Promise<SchedulerPassResult> {
    // Recovery before enqueuing (SRS 7.6): a run left RUNNING by a dead worker still holds
    // the one-active-run lock, so the source must be released before its catch-up run starts.
    const reaped = await this.deps.sourceRuns.reapStaleRuns(this.options.staleRunSeconds);
    if (reaped.length > 0) {
      this.logger.warn('reaped stale runs before scheduling', { count: reaped.length });
    }

    const sources = await this.deps.sources.listSchedulable();
    const enqueued: string[] = [];
    const invalidSchedules: string[] = [];

    for (const source of sources) {
      if (source.schedule === null || source.schedule.trim() === '') continue;

      const intervalMs = parseScheduleInterval(source.schedule);
      if (intervalMs === null) {
        invalidSchedules.push(source.id);
        this.logger.error('source has an unparseable schedule; it will never be collected', {
          sourceId: source.id,
          name: source.name,
          schedule: source.schedule,
        });
        continue;
      }

      const dueAt = source.lastAttemptAt === null ? 0 : source.lastAttemptAt.getTime() + intervalMs;
      if (dueAt > now.getTime()) continue;

      const payload: SourceCollectionTaskPayload = { sourceId: source.id, trigger };
      await this.deps.tasks.enqueue({
        type: SOURCE_COLLECTION_TASK_TYPE,
        payload,
        dedupeKey: sourceCollectionDedupeKey(source.id),
      });
      enqueued.push(source.id);
    }

    return { enqueued, invalidSchedules, reapedRuns: reaped.length };
  }

  /** Run the startup catch-up pass, then a periodic pass until `stop()`. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const controller = new AbortController();
    this.controller = controller;
    this.logger.info('scheduler started', { intervalMs: this.options.intervalMs });

    // Startup catch-up (SRS 7.6): runs missed while offline are enqueued here, once, and
    // recorded with the STARTUP trigger so a late run is distinguishable from an on-time one.
    // A failed catch-up must not stop the loop: the next pass retries the same decision.
    try {
      await this.runOnce(new Date(), SourceRunTrigger.STARTUP);
    } catch (error) {
      this.logger.error('startup catch-up pass failed', { error: describeError(error) });
    }
    this.loopPromise = this.loop(controller.signal);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.controller?.abort();
    await this.loopPromise;
    this.controller = undefined;
    this.loopPromise = undefined;
    this.logger.info('scheduler stopped');
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(this.options.intervalMs, signal);
      if (signal.aborted) return;
      try {
        await this.runOnce(new Date());
      } catch (error) {
        // A failed pass must not kill the loop; the next interval retries.
        this.logger.error('scheduler pass failed', { error: describeError(error) });
      }
    }
  }
}
