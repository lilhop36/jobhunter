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
 * it runs after a run that finished SUCCEEDED, claimed coverage or not.
 *
 * Scoped to a single source so a sweep is a bounded, retryable unit of work rather than a
 * table-wide scan, and so one source's sweep cannot be starved by another's.
 *
 * What makes a run *informative* is not decided here: the read model only offers, for each Job,
 * a run that can speak for it - one that captured the Job, read the listing to the end, or read
 * down past the Job's publication date - and the run before that one. That is why the sweep can
 * run after any successful collection: presence restores on its own evidence, and absence
 * retires only against consecutive runs that actually covered the Job (ADR-0010, audit M1, L9).
 *
 * Every move is logged with the evidence and the policy version that decided it. No column
 * stores a lifecycle reason, so the log is the audit trail; this is why the policy returns a
 * reason instead of a bare status.
 *
 * The handler decides when to look; this class decides what the evidence supports and writes
 * each move fenced on the status it read, so a determination made by another writer - or by the
 * deadline pass - is not overwritten by an older conclusion here.
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
        newestQualifyingRun: candidate.newestQualifyingRun,
        retirementCutoffRun: candidate.retirementCutoffRun,
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
      updates.push({
        jobId: candidate.jobId,
        expectedStatus: candidate.currentStatus,
        status: decision.status,
      });
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
    if (applied < updates.length) {
      // The row moved between this read and the fenced write, so another determination is now
      // on it - a concurrent sweep, a deadline pass, or a newer collection. Leaving it alone is
      // the correct outcome; saying so is what makes the race visible instead of mysterious.
      this.deps.logger.info('lifecycle sweep left newer state untouched', {
        sourceId,
        decided: updates.length,
        applied,
        superseded: updates.length - applied,
        policy: LIFECYCLE_POLICY_VERSION,
      });
    }
    return { sourceId, examined: candidates.length, retired, restored };
  }
}
