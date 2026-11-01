import { HealthStatus, SourceRunTrigger } from '@domain/enums';
import { parseScheduleInterval } from '@domain/scheduling/schedule-interval';
import {
  SOURCE_SILENCE_POLICY_VERSION,
  classifySourceSilence,
} from '@domain/health/source-silence';
import type { JobSourceRepository, SchedulableSource } from '@ports/job-source-repository';
import type { JobSourceAdapter } from '@ports/source-adapter';
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
  /**
   * Sources whose schedule is present but unparseable, newly reported this pass; these are never
   * scheduled.
   */
  invalidSchedules: string[];
  /** Abandoned runs recovered before enqueuing (SRS 7.6). */
  reapedRuns: number;
  /**
   * Sources newly reported as silent this pass (SRS 7.8): healthy on paper, but nothing has
   * arrived from them for longer than their own schedule allows.
   */
  silentSourceIds: string[];
  /**
   * Sources a collection was due for, but for which no adapter is configured (SRS 7.2,
   * Appendix E), newly reported this pass. A configuration error, not a runtime failure: the
   * source cannot be collected until its approval is registered, and no retry can change that.
   */
  unconfiguredSourceIds: string[];
}

export interface SourceSchedulerDeps {
  sources: JobSourceRepository;
  sourceRuns: SourceRunRepository;
  tasks: WorkTaskRepository;
  /**
   * The same adapter resolver the collection handler runs (SRS 7.2; ADR-0004), consulted
   * before a task is created. Without it the scheduler cannot tell a source that is due from
   * one that could never be collected, and every 30-second pass enqueues a task whose only
   * possible outcome is a permanent failure (audit M4).
   */
  resolveAdapter: (sourceId: string) => Promise<JobSourceAdapter | null>;
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
 *
 * Due-ness alone does not say a source *should* be collected. A source with no registered adapter
 * stays due forever, because the attempt that would move the clock is the run that can never
 * happen, so the registry is asked before the queue is written and the source is reported as the
 * configuration error it is (audit M4).
 */
export class SourceScheduler {
  private readonly options: ResolvedOptions;
  private started = false;
  private controller?: AbortController;
  private loopPromise?: Promise<void>;
  /**
   * Per-source configuration errors already logged. Neither heals on its own — an approval is
   * registered in code and a schedule is fixed in the row — so repeating it every 30 seconds
   * would only bury the operator's log under one known-broken source.
   *
   * ponytail: the memory is the only record, so a restart re-reports once; persist the finding on
   * the source row if it must survive restarts without a log search.
   */
  private readonly reportedConfigErrors = new Set<string>();

  constructor(
    private readonly deps: SourceSchedulerDeps,
    options: SourceSchedulerOptions,
    private readonly logger: WorkerLogger = consoleWorkerLogger,
  ) {
    this.options = resolveOptions(options);
  }

  /** Logs the error and returns true when this pass was the first to see this source's problem. */
  private reportConfigError(
    key: string,
    message: string,
    meta: { sourceId: string; name: string; [detail: string]: unknown },
  ): boolean {
    if (this.reportedConfigErrors.has(key)) return false;
    this.reportedConfigErrors.add(key);
    this.logger.error(message, meta);
    return true;
  }

  /**
   * One pass: recover abandoned runs, then enqueue a collection for every due source the
   * registry can actually build an adapter for. `runOnce(now, STARTUP)` is the startup
   * catch-up pass.
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
    const enqueuedIds = new Set<string>();
    const invalidSchedules: string[] = [];
    const unconfiguredSourceIds: string[] = [];

    const enqueueCollection = async (source: SchedulableSource): Promise<void> => {
      // Ask the registry before the queue. A source with no adapter still produces a task, and
      // that task can only fail permanently; because no run is ever created, due-ness never
      // advances and every pass re-offered the same impossible work (audit M4). The resolve is a
      // primary-key read, so asking on every pass costs less than the task rows it prevents.
      if ((await this.deps.resolveAdapter(source.id)) === null) {
        if (
          this.reportConfigError(
            `unconfigured-adapter:${source.id}`,
            'no adapter is configured for source; it will never be collected',
            { sourceId: source.id, name: source.name },
          )
        ) {
          unconfiguredSourceIds.push(source.id);
        }
        return;
      }
      const payload: SourceCollectionTaskPayload = { sourceId: source.id, trigger };
      const result = await this.deps.tasks.enqueueOrConflict({
        type: SOURCE_COLLECTION_TASK_TYPE,
        payload,
        dedupeKey: sourceCollectionDedupeKey(source.id),
      });
      if (result.created && !enqueuedIds.has(source.id)) {
        enqueuedIds.add(source.id);
        enqueued.push(source.id);
      }
    };

    // A run reclaimed as stale has freed its source, but the run's `startedAt` is also the
    // source's last attempt, so due-ness would otherwise hold it until its next 3h/6h
    // interval - a crash near a scheduled run would silently skip a whole cycle (H3).
    // Enqueue the recovery immediately. The active-only dedupe key makes this idempotent:
    // if the crashed task was deferred and is already waiting, nothing new is created.
    const schedulable = new Map(sources.map((source) => [source.id, source]));
    for (const run of reaped) {
      const source = schedulable.get(run.sourceId);
      if (source === undefined) continue; // disabled or removed: nothing to collect
      await enqueueCollection(source);
    }

    for (const source of sources) {
      if (source.schedule === null || source.schedule.trim() === '') continue;

      const intervalMs = parseScheduleInterval(source.schedule);
      if (intervalMs === null) {
        if (
          this.reportConfigError(
            `unparseable-schedule:${source.id}`,
            'source has an unparseable schedule; it will never be collected',
            { sourceId: source.id, name: source.name, schedule: source.schedule },
          )
        ) {
          invalidSchedules.push(source.id);
        }
        continue;
      }

      const dueAt = source.lastAttemptAt === null ? 0 : source.lastAttemptAt.getTime() + intervalMs;
      if (dueAt > now.getTime()) continue;

      await enqueueCollection(source);
    }

    // Silence, the failure this pass is the only place that can see (SRS 7.8). Health is written
    // when a run finalizes, so a source that stops being collected — never enqueued, always
    // dead-lettered, an adapter that will not resolve — keeps the `HEALTHY` of its last run
    // indefinitely, and the dashboard shows a green row for a dead source. Comparing the age of
    // the last *success* against the source's own interval, on a pass that runs whether or not
    // anything is due, is what turns "nothing happened" into something the operator is told. A
    // source enqueued by the loop above is still judged: being queued is not having delivered, and
    // the run that succeeds will restore `HEALTHY` through the health policy.
    const silentSourceIds: string[] = [];
    for (const source of sources) {
      if (source.healthStatus !== HealthStatus.HEALTHY) continue; // something worse is already known
      const verdict = classifySourceSilence({
        lastSuccessfulRunAt: source.lastSuccessfulRunAt,
        schedule: source.schedule,
        now,
      });
      if (!verdict.silent || verdict.silentBefore === null) continue;

      // The store re-checks the bound it was given, so a collection that succeeded between the
      // read above and this write owns the row again and is not stamped for a silence it ended.
      const marked = await this.deps.sources.markSourceSilent(source.id, verdict.silentBefore);
      // Nothing was written, which means one of two things — the source is already silent, or it
      // stopped being silent. Neither is a new fact, and neither is worth a second warning line.
      if (!marked) continue;

      silentSourceIds.push(source.id);
      this.logger.warn('source has gone silent', {
        sourceId: source.id,
        name: source.name,
        reason: verdict.reason,
        policy: SOURCE_SILENCE_POLICY_VERSION,
        lastSuccessfulRunAt: source.lastSuccessfulRunAt?.toISOString() ?? null,
      });
    }

    return {
      enqueued,
      invalidSchedules,
      reapedRuns: reaped.length,
      silentSourceIds,
      unconfiguredSourceIds,
    };
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
