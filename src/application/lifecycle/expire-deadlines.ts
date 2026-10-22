import { LifecycleStatus } from '@domain/enums';
import {
  DEADLINE_POLICY_VERSION,
  classifyDeadline,
} from '@domain/lifecycle/deadline-policy';
import type { JobRepository, LifecycleStatusUpdate } from '@ports/job-repository';
import type { WorkerLogger } from '@ports/worker-logger';

export interface ExpireDeadlinesDeps {
  jobs: JobRepository;
  logger: WorkerLogger;
}

export interface ExpireDeadlinesResult {
  /** Jobs the deadline policy owned. */
  examined: number;
  /** Jobs that moved to EXPIRED on this pass. */
  expired: number;
  /** Jobs that moved back to ACTIVE because the evidence no longer supports expiry. */
  restored: number;
}

/**
 * FR-019 (SRS 4.4): reconcile stored deadlines against the clock.
 *
 * Kept separate from `SweepSourceLifecycle` on purpose. That sweep retires a job from *listing
 * presence*, which is only sound when a collection covers the source's live catalogue — a
 * source whose run reads the newest page would otherwise retire everything older. A stated
 * deadline needs no such coverage: it is a fact about the posting, so this pass is table-wide,
 * runs wherever scoring starts, and never retires anything the source still publishes.
 *
 * It is also how an expiry is *reversed*: a re-collected posting whose deadline moved forward
 * (or was removed) goes back to ACTIVE, because the evidence that justified EXPIRED is gone.
 * `REMOVED` and `NOT_FOUND` are never touched here.
 */
export class ExpireDeadlines {
  constructor(private readonly deps: ExpireDeadlinesDeps) {}

  async run(input: { now: Date }): Promise<ExpireDeadlinesResult> {
    const candidates = await this.deps.jobs.listDeadlineCandidates();
    const updates: LifecycleStatusUpdate[] = [];
    let expired = 0;
    let restored = 0;

    for (const candidate of candidates) {
      const decision = classifyDeadline({
        currentStatus: candidate.currentStatus,
        applicationDeadline: candidate.applicationDeadline,
        now: input.now,
      });
      if (decision.status === candidate.currentStatus) continue;

      this.deps.logger.info('job lifecycle changed', {
        jobId: candidate.jobId,
        from: candidate.currentStatus,
        to: decision.status,
        policy: DEADLINE_POLICY_VERSION,
        reason: decision.reason,
      });
      if (decision.status === LifecycleStatus.EXPIRED) expired += 1;
      else restored += 1;
      updates.push({ jobId: candidate.jobId, status: decision.status });
    }

    const changed = await this.deps.jobs.applyLifecycleStatuses(updates);
    if (changed > 0) {
      this.deps.logger.info('deadline reconciliation applied', {
        examined: candidates.length,
        expired,
        restored,
        changed,
        policy: DEADLINE_POLICY_VERSION,
      });
    }
    return { examined: candidates.length, expired, restored };
  }
}
