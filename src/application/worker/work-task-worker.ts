import { WorkTaskFailure, WorkTaskRecord } from '@domain/types';
import { WorkTaskRepository } from '@ports/work-task-repository';
import { consoleWorkerLogger, WorkerLogger } from '@ports/worker-logger';
import { classifyWorkTaskError, describeError } from './work-task-handler';
import { WorkTaskHandlerRegistry } from './work-task-handler-registry';

export interface WorkTaskWorkerOptions {
  /** Stable identity recorded on claims (`lockedBy`). */
  workerId: string;
  /** Lease granted per claim, in seconds. Default 60. */
  leaseSeconds?: number;
  /** Heartbeat cadence. Must be shorter than the lease. Defaults to a third of it. */
  heartbeatIntervalMs?: number;
  /** Idle wait between claim attempts. Default 1000ms. */
  pollIntervalMs?: number;
  /** How often to recover expired leases. Default 30s. */
  reaperIntervalMs?: number;
  /** Upper bound for graceful shutdown. Default 10s. */
  shutdownTimeoutMs?: number;
}

interface ResolvedOptions {
  workerId: string;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  reaperIntervalMs: number;
  shutdownTimeoutMs: number;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive, finite number; received ${String(value)}`);
  }
  return value;
}

function resolveOptions(options: WorkTaskWorkerOptions): ResolvedOptions {
  if (!options.workerId) throw new Error('workerId is required');

  const leaseSeconds = positive(options.leaseSeconds ?? 60, 'leaseSeconds');
  const heartbeatIntervalMs = positive(
    options.heartbeatIntervalMs ?? Math.floor((leaseSeconds * 1000) / 3),
    'heartbeatIntervalMs',
  );
  if (heartbeatIntervalMs >= leaseSeconds * 1000) {
    throw new RangeError('heartbeatIntervalMs must be shorter than leaseSeconds');
  }
  const pollIntervalMs = positive(options.pollIntervalMs ?? 1000, 'pollIntervalMs');
  const reaperIntervalMs = positive(options.reaperIntervalMs ?? 30_000, 'reaperIntervalMs');
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs < 0) {
    throw new RangeError('shutdownTimeoutMs must be a finite number >= 0');
  }

  return {
    workerId: options.workerId,
    leaseSeconds,
    heartbeatIntervalMs,
    pollIntervalMs,
    reaperIntervalMs,
    shutdownTimeoutMs,
  };
}

/**
 * Abort-aware wait, shared with the worker runtime's own background loop: an aborted process
 * stops waiting at once instead of leaving a live timer behind the shutdown barrier.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Generic work-queue worker.
 *
 * Lifecycle: `start()` runs a claim/dispatch loop and an expired-lease recovery
 * loop until `stop()` is called. `stop()` stops claiming, aborts the in-flight
 * handler, and waits (bounded by `shutdownTimeoutMs`) for the loops to unwind.
 *
 * Guarantees:
 *   - Handlers run outside any database transaction. Repository calls are single
 *     statements, so no transaction is held open while a handler does work.
 *   - Heartbeats keep a long-running attempt's lease alive. If the lease is lost
 *     (reaped and re-claimed), execution is aborted and the stale completion is
 *     rejected by the repository, so a stale worker never overwrites a newer
 *     claim.
 *   - The worker classifies failures only as retryable or permanent; retry
 *     limits, backoff and terminal states are owned by the repository.
 */
export class WorkTaskWorker {
  private readonly options: ResolvedOptions;
  private started = false;
  private runController?: AbortController;
  private activeController?: AbortController;
  private pollLoopPromise?: Promise<void>;
  private reaperLoopPromise?: Promise<void>;
  private heartbeatInFlight = false;

  constructor(
    private readonly repository: WorkTaskRepository,
    private readonly handlers: WorkTaskHandlerRegistry,
    options: WorkTaskWorkerOptions,
    private readonly logger: WorkerLogger = consoleWorkerLogger,
  ) {
    this.options = resolveOptions(options);
  }

  get workerId(): string {
    return this.options.workerId;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const controller = new AbortController();
    this.runController = controller;
    this.logger.info('worker started', { workerId: this.options.workerId });
    this.pollLoopPromise = this.pollLoop(controller.signal);
    this.reaperLoopPromise = this.reaperLoop(controller.signal);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.logger.info('worker stopping', { workerId: this.options.workerId });

    this.runController?.abort(); // stop claiming / waiting
    this.activeController?.abort(); // abort in-flight execution so the lease is released

    const loops = Promise.all([
      this.pollLoopPromise ?? Promise.resolve(),
      this.reaperLoopPromise ?? Promise.resolve(),
    ]);
    await Promise.race([
      loops,
      sleep(this.options.shutdownTimeoutMs, new AbortController().signal),
    ]);

    this.runController = undefined;
    this.pollLoopPromise = undefined;
    this.reaperLoopPromise = undefined;
    this.logger.info('worker stopped', { workerId: this.options.workerId });
  }

  /** Claim and process at most one task. Returns false when nothing was due. */
  async runOnce(): Promise<boolean> {
    const task = await this.repository.claim(this.options.workerId, this.options.leaseSeconds);
    if (!task) return false;
    this.logger.info('claimed task', {
      taskId: task.id,
      type: task.type,
      attempt: task.attempts,
    });
    await this.processClaimed(task);
    return true;
  }

  /** Recover expired leases once. Returns the number of tasks put back. */
  async reapOnce(): Promise<number> {
    try {
      const reaped = await this.repository.reapExpiredLeases();
      if (reaped > 0) this.logger.warn('recovered expired leases', { count: reaped });
      return reaped;
    } catch (error) {
      this.logger.error('expired-lease recovery failed', { error: describeError(error) });
      return 0;
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let processed = false;
      try {
        processed = await this.runOnce();
      } catch (error) {
        this.logger.error('claim/dispatch iteration failed', { error: describeError(error) });
      }
      if (!processed) await sleep(this.options.pollIntervalMs, signal);
    }
  }

  private async reaperLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.reapOnce();
      await sleep(this.options.reaperIntervalMs, signal);
    }
  }

  private async processClaimed(task: WorkTaskRecord): Promise<void> {
    const leaseToken = task.leaseToken;
    if (!leaseToken) {
      this.logger.error('claimed task without a lease token; leaving it for lease recovery', {
        taskId: task.id,
      });
      return;
    }

    const handler = this.handlers.get(task.type);
    if (!handler) {
      await this.reportFailure(task, leaseToken, {
        message: `no handler registered for work task type "${task.type}"`,
        retryable: false,
      });
      return;
    }

    const controller = new AbortController();
    this.activeController = controller;
    const timer = setInterval(() => {
      void this.heartbeat(task, leaseToken, controller);
    }, this.options.heartbeatIntervalMs);

    try {
      await handler({ task, signal: controller.signal });
      if (controller.signal.aborted) {
        // The handler finished only because it was aborted. Do not mark the work
        // as done; release it so a fresh attempt can run.
        await this.reportFailure(task, leaseToken, {
          message: 'attempt aborted before completion (shutdown or lease lost)',
          retryable: true,
        });
        return;
      }
      await this.reportSuccess(task, leaseToken);
    } catch (error) {
      if (controller.signal.aborted) {
        await this.reportFailure(task, leaseToken, {
          message: 'attempt aborted during execution (shutdown or lease lost)',
          retryable: true,
        });
        return;
      }
      await this.reportFailure(task, leaseToken, classifyWorkTaskError(error));
    } finally {
      clearInterval(timer);
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private async heartbeat(
    task: WorkTaskRecord,
    leaseToken: string,
    controller: AbortController,
  ): Promise<void> {
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      const extended = await this.repository.heartbeat(
        task.id,
        leaseToken,
        this.options.leaseSeconds,
      );
      if (!extended && !controller.signal.aborted) {
        this.logger.warn('heartbeat rejected; aborting execution', { taskId: task.id });
        controller.abort();
      }
    } catch (error) {
      // A transient heartbeat error is not fatal on its own: if the lease really
      // lapses, recovery re-claims it and our completion is rejected.
      this.logger.error('heartbeat failed', { taskId: task.id, error: describeError(error) });
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private async reportSuccess(task: WorkTaskRecord, leaseToken: string): Promise<void> {
    const completed = await this.repository.complete(task.id, leaseToken);
    if (!completed) {
      this.logger.warn('completion rejected: lease is no longer owned', { taskId: task.id });
      return;
    }
    this.logger.info('task completed', { taskId: task.id, type: task.type });
  }

  private async reportFailure(
    task: WorkTaskRecord,
    leaseToken: string,
    failure: WorkTaskFailure,
  ): Promise<void> {
    const updated = await this.repository.fail(task.id, leaseToken, failure);
    if (!updated) {
      this.logger.warn('failure report rejected: lease is no longer owned', {
        taskId: task.id,
        retryable: failure.retryable,
      });
      return;
    }
    this.logger.warn('attempt failed', {
      taskId: task.id,
      type: task.type,
      status: updated.status,
      retryable: failure.retryable,
      attempts: updated.attempts,
      maxAttempts: updated.maxAttempts,
      message: failure.message,
    });
  }
}
