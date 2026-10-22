import {
  PermanentWorkTaskError,
  describeError,
  type WorkTaskHandler,
} from '@application/worker';
import { consoleWorkerLogger, type WorkerLogger } from '@ports/worker-logger';
import type { ExpireDeadlines } from '@application/lifecycle';
import type { ScoreMatches } from './score-matches';

/**
 * Work task type for scoring a source's matchable jobs (SRS 11.2, FR-013).
 *
 * One task per source run, never one per job: a run's whole result set is scored in a single
 * attempt, and the task is deduplicated by key (see `matchScoringDedupeKey`), so a run's
 * hand-off can exist at most once no matter how many observers notice the run finished.
 */
export const MATCH_SCORING_TASK_TYPE = 'match.score';

/**
 * Why a scoring task was enqueued. Carried on the payload so a scored job can be traced to the
 * event that asked for it, and so a backfill is distinguishable from the normal hand-off.
 */
export const MATCH_SCORING_TRIGGERS = [
  /** A collection run finished and its jobs need scoring. */
  'SOURCE_RUN',
  /** The candidate profile changed, so every stored match's inputs are stale. */
  'PROFILE_CHANGED',
  /** The matcher version changed, so stored rows were produced by different rules (ENG-013). */
  'MATCHER_VERSION_CHANGED',
] as const;

export type MatchScoringTrigger = (typeof MATCH_SCORING_TRIGGERS)[number];

export interface MatchScoringTaskPayload {
  /** The source whose jobs are scored. */
  sourceId: string;
  /**
   * The collection run that produced the jobs when the trigger was a completed run. It scopes
   * the dedupe key.
   *
   * `null` for a backfill: a profile edit or a matcher change affects every source's jobs and
   * belongs to no single run, so the scope becomes the source.
   */
  sourceRunId: string | null;
  trigger: MatchScoringTrigger;
}

/**
 * Dedupe key for a scoring task.
 *
 * A run-scoped task is keyed by the run alone (`match.score:{sourceRunId}`), so the hand-off for
 * one run can only be enqueued once. A backfill has no run to point at and is keyed by the
 * source under a `source:` prefix — a prefix rather than a bare id so a source id can never
 * collide with a run id in the same namespace.
 */
export function matchScoringDedupeKey(scope: {
  sourceId: string;
  sourceRunId: string | null;
}): string {
  return scope.sourceRunId === null
    ? `${MATCH_SCORING_TASK_TYPE}:source:${scope.sourceId}`
    : `${MATCH_SCORING_TASK_TYPE}:${scope.sourceRunId}`;
}

const VALID_TRIGGERS: ReadonlySet<string> = new Set<string>(MATCH_SCORING_TRIGGERS);

/**
 * Validate an untrusted task payload. A malformed payload is a permanent failure: retrying it
 * unchanged can never succeed.
 */
export function parseMatchScoringTaskPayload(payload: unknown): MatchScoringTaskPayload {
  const value = payload as { sourceId?: unknown; sourceRunId?: unknown; trigger?: unknown } | null;

  const sourceId = value?.sourceId;
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new PermanentWorkTaskError('match scoring task payload requires a sourceId');
  }

  const sourceRunId = value?.sourceRunId ?? null;
  if (sourceRunId !== null && (typeof sourceRunId !== 'string' || sourceRunId.length === 0)) {
    throw new PermanentWorkTaskError('match scoring task payload has an invalid sourceRunId');
  }

  const trigger = value?.trigger;
  if (typeof trigger !== 'string' || !VALID_TRIGGERS.has(trigger)) {
    throw new PermanentWorkTaskError(
      `match scoring task payload has an invalid trigger: ${String(trigger)}`,
    );
  }

  return { sourceId, sourceRunId, trigger: trigger as MatchScoringTrigger };
}

export interface MatchScoringHandlerOptions {
  scoring: ScoreMatches;
  /**
   * Deadline reconciliation, run before scoring (FR-019). Scoring is where "ACTIVE" starts to
   * matter, so expiry happens here rather than on a timer of its own: a job whose stated
   * deadline has passed is EXPIRED by the time the policy reads it, and is therefore neither
   * scored nor notified. It needs no collection of its own, so a source that is failing to
   * collect cannot keep its expired postings alive.
   */
  expire: ExpireDeadlines;
  logger?: WorkerLogger;
  /** Injected clock (ENG-012). Defaults to the wall clock. */
  now?: () => Date;
  /** Jobs read per page, forwarded to the use case. */
  pageSize?: number;
}

/**
 * Handler for {@link MATCH_SCORING_TASK_TYPE}: score the source's matchable jobs against every
 * profile.
 *
 * Nothing else is needed for idempotence. The task may be retried after a crash, and a rerun
 * re-scores the same jobs through `saveIfChanged`, which writes nothing when the output is
 * unchanged — so a crashed attempt followed by a rerun converges on one match per input set
 * rather than duplicating the work it managed to finish.
 */
export function createMatchScoringHandler(options: MatchScoringHandlerOptions): WorkTaskHandler {
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? consoleWorkerLogger;

  return async ({ task, signal }) => {
    const payload = parseMatchScoringTaskPayload(task.payload);
    const startedAt = Date.now();
    // One clock read for both steps, so expiry and scoring cannot disagree about "now".
    const evaluationTime = now();

    try {
      // Expire first, so this scoring pass cannot see a job whose deadline has already passed.
      // A failure here fails the attempt: scoring a stale catalogue would reserve notifications
      // for postings nobody can apply to any more.
      await options.expire.run({ now: evaluationTime });

      const result = await options.scoring.run({
        sourceId: payload.sourceId,
        now: evaluationTime,
        signal,
        ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      });
      logger.info('scored matchable jobs', {
        ...payload,
        ...result,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      // The worker records and classifies the failure; logging here adds the payload it
      // cannot see, so a dead-lettered task says which source and trigger it belonged to.
      logger.error('match scoring failed', {
        ...payload,
        durationMs: Date.now() - startedAt,
        error: describeError(error),
      });
      throw error;
    }
  };
}
