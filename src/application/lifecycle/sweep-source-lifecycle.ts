import { LIFECYCLE_POLICY_VERSION, classifyLifecycle } from '@domain/lifecycle/lifecycle-policy';
import type { JobRepository, LifecycleStatusUpdate } from '@ports/job-repository';
import type { WorkerLogger } from '@ports/worker-logger';

export interface SweepSourceLifecycleDeps {
  jobs: JobRepository;
  logger: WorkerLogger;
}

export interface SourceLifecycleSweepResult {
  sourceId: string;
  /** Jobs the policy owned for this source. */
  examined: number;
  /** Jobs whose persisted status actually moved. */
  changed: number;
}

/**
 * FR-019 (SRS 4.4): reconcile one source's Job lifecycle against its collection history.
 *
 * Scoped to a single source so a sweep is a bounded, retryable unit of work rather than a
 * table-wide scan, and so one source's sweep cannot be starved by another's.
 *
 * Every move is logged with the evidence and the policy version that decided it. No column
 * stores a lifecycle reason, so the log is the audit trail; this is why the policy returns a
 * reason instead of a bare status.
 *
 * This is not wired to a trigger yet: nothing enqueues a sweep, so it runs only when called.
 * It is the unit the worker will run once the post-collection hand-off exists.
 */
export class SweepSourceLifecycle {
  constructor(private readonly deps: SweepSourceLifecycleDeps) {}

  async sweep(sourceId: string): Promise<SourceLifecycleSweepResult> {
    const candidates = await this.deps.jobs.listLifecycleCandidates(sourceId);
    const updates: LifecycleStatusUpdate[] = [];

    for (const candidate of candidates) {
      const decision = classifyLifecycle({
        currentStatus: candidate.currentStatus,
        lastObservedAt: candidate.lastObservedAt,
        latestQualifyingRunStartedAt: candidate.latestQualifyingRunStartedAt,
      });
      if (decision.status === candidate.currentStatus) continue;

      this.deps.logger.info('job lifecycle changed', {
        sourceId,
        jobId: candidate.jobId,
        from: candidate.currentStatus,
        to: decision.status,
        policy: LIFECYCLE_POLICY_VERSION,
        reason: decision.reason,
      });
      updates.push({ jobId: candidate.jobId, status: decision.status });
    }

    const changed = await this.deps.jobs.applyLifecycleStatuses(updates);
    if (changed > 0) {
      this.deps.logger.info('lifecycle sweep applied', {
        sourceId,
        examined: candidates.length,
        changed,
        policy: LIFECYCLE_POLICY_VERSION,
      });
    }
    return { sourceId, examined: candidates.length, changed };
  }
}
