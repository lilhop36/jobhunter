import { LifecycleStatus } from '@domain/enums';
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
  /** Jobs the policy decided to retire as REMOVED (applied count is logged separately). */
  retired: number;
  /** Jobs the policy decided to restore to ACTIVE. */
  restored: number;
}

/**
 * FR-019 (SRS 4.4): reconcile one source's Job lifecycle against its collection history.
 * Wired as a post-collection step of the source collection handler (apps/worker/runtime.ts):
 * it runs after a run that finished SUCCEEDED and made a coverage claim (read the listing to
 * the end, or recorded the publication-date window it read).
 *
 * Scoped to a single source so a sweep is a bounded, retryable unit of work rather than a
 * table-wide scan, and so one source's sweep cannot be starved by another's.
 *
 * Every move is logged with the evidence and the policy version that decided it. No column
 * stores a lifecycle reason, so the log is the audit trail; this is why the policy returns a
 * reason instead of a bare status.
 *
 * The handler decides whether a run may drive a sweep; this class only executes it and
 * reports what moved.
 */
export class SweepSourceLifecycle {
  constructor(private readonly deps: SweepSourceLifecycleDeps) {}

  async sweep(sourceId: string): Promise<SourceLifecycleSweepResult> {
    const candidates = await this.deps.jobs.listLifecycleCandidates(sourceId);
    const updates: LifecycleStatusUpdate[] = [];
    let retired = 0;
    let restored = 0;

    for (const candidate of candidates) {
      const decision = classifyLifecycle({
        currentStatus: candidate.currentStatus,
        lastObservedAt: candidate.lastObservedAt,
        publishedAt: candidate.publishedAt,
        latestQualifyingRun: candidate.latestQualifyingRun,
      });
      if (decision.status === candidate.currentStatus) continue;

      if (decision.status === LifecycleStatus.REMOVED) retired += 1;
      else restored += 1;

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

    const applied = await this.deps.jobs.applyLifecycleStatuses(updates);
    if (applied > 0) {
      this.deps.logger.info('lifecycle sweep applied', {
        sourceId,
        examined: candidates.length,
        retired,
        restored,
        applied,
        policy: LIFECYCLE_POLICY_VERSION,
      });
    }
    return { sourceId, examined: candidates.length, retired, restored };
  }
}
