import type { JobSourceRepository } from '@ports/job-source-repository';
import type { WorkTaskRepository } from '@ports/work-task-repository';
import { consoleWorkerLogger, type WorkerLogger } from '@ports/worker-logger';
import {
  MATCH_SCORING_TASK_TYPE,
  matchScoringDedupeKey,
  type MatchScoringTaskPayload,
  type MatchScoringTrigger,
} from './match-scoring-handler';

/** The reasons a full re-score can be requested, as opposed to a run-scoped hand-off. */
export type MatchBackfillReason = Exclude<MatchScoringTrigger, 'SOURCE_RUN'>;

export interface RequestMatchBackfillDeps {
  sources: JobSourceRepository;
  tasks: WorkTaskRepository;
  logger?: WorkerLogger;
}

export interface RequestMatchBackfillResult {
  /** Sources whose backfill task this call created. */
  enqueued: string[];
  /** Sources that already had an active backfill task, so the request coalesced. */
  alreadyQueued: string[];
}

/**
 * Re-scores every enabled source's jobs (SRS 11.2; ADR-0005 §9).
 *
 * ## How the two triggers start
 *
 * Two events invalidate every stored match, and neither belongs to a collection run:
 *
 *   1. **The candidate profile changed.** A profile edit changes `profileVersion`, so every
 *      stored row was scored against inputs that no longer exist. The caller is whoever
 *      performs the save — the profile write path and the `seed:candidate` path — and this use
 *      case is what it calls afterwards, with `PROFILE_CHANGED`.
 *   2. **The matcher version changed.** Stored rows carry the `matcherVersion` that produced
 *      them (ENG-013), so a deploy that changes `MATCHER_VERSION` makes them stale. The caller
 *      is a startup check that compares the running `MATCHER_VERSION` with what is stored and
 *      asks for a backfill with `MATCHER_VERSION_CHANGED`, so a new matcher re-scores itself
 *      instead of waiting for every source to be collected again.
 *
 * **Neither caller is wired yet.** This use case is the entry point they need; until something
 * calls it, a backfill only happens when an operator asks for one. That is stated rather than
 * implied — see the increment report.
 *
 * ## Shape
 *
 * One task per source, not per job, under the source-scoped dedupe key, so repeated requests
 * while a backfill is pending coalesce instead of stacking. Sources are the enabled ones: a
 * disabled source is not being collected, so its jobs are not worth re-scoring on their behalf.
 */
export class RequestMatchBackfill {
  constructor(private readonly deps: RequestMatchBackfillDeps) {}

  async run(input: { reason: MatchBackfillReason }): Promise<RequestMatchBackfillResult> {
    const logger = this.deps.logger ?? consoleWorkerLogger;
    const sources = await this.deps.sources.listSchedulable();
    const result: RequestMatchBackfillResult = { enqueued: [], alreadyQueued: [] };

    for (const source of sources) {
      const payload: MatchScoringTaskPayload = {
        sourceId: source.id,
        sourceRunId: null,
        trigger: input.reason,
      };
      const { created } = await this.deps.tasks.enqueueOrConflict({
        type: MATCH_SCORING_TASK_TYPE,
        payload,
        dedupeKey: matchScoringDedupeKey(payload),
      });
      if (created) result.enqueued.push(source.id);
      else result.alreadyQueued.push(source.id);
    }

    logger.info('requested a match backfill', {
      reason: input.reason,
      enqueued: result.enqueued.length,
      alreadyQueued: result.alreadyQueued.length,
    });

    return result;
  }
}
