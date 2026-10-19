import { PrismaClient } from '@prisma/client';
import {
  RunSourceCollection,
  SOURCE_COLLECTION_TASK_TYPE,
  createSourceCollectionHandler,
} from '@application/ingestion';
import { SourceScheduler } from '@application/scheduling';
import {
  MATCH_SCORING_TASK_TYPE,
  RequestMatchBackfill,
  ScoreMatches,
  createMatchScoringHandler,
} from '@application/matching';
import { WorkTaskHandlerRegistry, WorkTaskWorker, describeError } from '@application/worker';
import { MATCHER_VERSION } from '@domain/matching';
import { PrismaCandidateProfileRepository } from '@infrastructure/ingestion/prisma-candidate-profile-repository';
import { PrismaJobMatchRepository } from '@infrastructure/ingestion/prisma-job-match-repository';
import { PrismaJobRepository } from '@infrastructure/ingestion/prisma-job-repository';
import { PrismaJobSourceRepository } from '@infrastructure/ingestion/prisma-job-source-repository';
import { PrismaRawJobRepository } from '@infrastructure/ingestion/prisma-raw-job-repository';
import { PrismaSourceRunRepository } from '@infrastructure/ingestion/prisma-source-run-repository';
import { PrismaMatchableJobReader } from '@infrastructure/matching/prisma-matchable-job-reader';
import { PrismaWorkTaskRepository } from '@infrastructure/work-tasks/prisma-work-task-repository';
import type { JobSourceAdapter } from '@ports/source-adapter';
import { consoleWorkerLogger, type WorkerLogger } from '@ports/worker-logger';
import { createAdapterRegistryResolver } from './adapters';
import type { WorkerConfig } from './config';

/**
 * Composition root for the worker process (SRS 2.5, 7.2; ENG-017).
 *
 * Every piece of infrastructure is constructed here and nowhere else, so the entry point
 * only has to decide configuration and logger, and a test can build the exact same runtime
 * with a test adapter.
 */
export interface WorkerRuntimeDeps {
  /**
   * Builds the adapter for one source, or returns null when none is registered. Defaults to
   * the production registry (`PRODUCTION_ADAPTERS` in `./adapters`, SRS 7.2 / Appendix E): a source is
   * collected only when it has an APPROVED record, so a source without one is a clear
   * permanent failure rather than a silent no-op. Tests inject the fake adapter here.
   */
  resolveAdapter?: (sourceId: string) => Promise<JobSourceAdapter | null>;
  logger?: WorkerLogger;
}

export interface WorkerRuntime {
  /** Recover abandoned work, then start claiming and scheduling. */
  start(): Promise<void>;
  /** Stop scheduling, stop claiming, release the in-flight attempt, close the pool. */
  stop(): Promise<void>;
}

export function createWorkerRuntime(
  config: WorkerConfig,
  deps: WorkerRuntimeDeps,
): WorkerRuntime {
  const logger = deps.logger ?? consoleWorkerLogger;

  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const sourceRuns = new PrismaSourceRunRepository(prisma);
  const tasks = new PrismaWorkTaskRepository(prisma);
  const jobSources = new PrismaJobSourceRepository(prisma);
  const matchRepository = new PrismaJobMatchRepository(prisma);

  // The registry is the production adapter source (SRS 7.2 / Appendix E; ADR-0004); tests
  // substitute the fake adapter here.
  const resolveAdapter =
    deps.resolveAdapter ?? createAdapterRegistryResolver({ sources: jobSources });

  const collection = new RunSourceCollection({
    sourceRuns,
    rawJobs: new PrismaRawJobRepository(prisma),
    jobs: new PrismaJobRepository(prisma),
    tasks,
    logger,
  });

  // Matching (SRS 11.2, FR-013/FR-014). The reader narrows to matchable jobs, the profile
  // repository is the non-negotiable input, and the match repository owns the idempotent write.
  const scoring = new ScoreMatches({
    profiles: new PrismaCandidateProfileRepository(prisma),
    jobs: new PrismaMatchableJobReader(prisma),
    matches: matchRepository,
  });

  /** Re-scores every enabled source's jobs (SRS 11.2; ADR-0005 §9). */
  const backfillMatches = new RequestMatchBackfill({ sources: jobSources, tasks, logger });

  /**
   * The `MATCHER_VERSION_CHANGED` trigger: stored matches carry the revision that produced them
   * (ENG-013), so a deploy that changes `MATCHER_VERSION` leaves scores computed by different
   * rules. Asking for a backfill here is what makes that deploy re-score itself instead of
   * leaving every stored match stale until its source happens to be collected again.
   *
   * This is the only caller of the backfill so far. The other trigger, `PROFILE_CHANGED`, has no
   * caller because nothing writes a profile yet: there is no profile endpoint (SRS 3.4 lists
   * `PUT /api/profile`, which v1 does not implement) and `saveForUser` is reached only from the
   * seed script and tests.
   */
  const requestMatcherVersionBackfill = async (): Promise<void> => {
    try {
      if (!(await matchRepository.hasMatchesForOtherMatcherVersion(MATCHER_VERSION))) return;

      const result = await backfillMatches.run({ reason: 'MATCHER_VERSION_CHANGED' });
      logger.info('matcher version changed; every stored match is being recomputed', {
        matcherVersion: MATCHER_VERSION,
        enqueued: result.enqueued.length,
        alreadyQueued: result.alreadyQueued.length,
      });
    } catch (error) {
      // Correctness does not depend on this: a stale match is recomputed the next time its
      // source is collected. A database that cannot answer the question is a problem the first
      // collection reports far more clearly, so it must not stop the worker from starting.
      logger.warn('could not request a matcher-version backfill', {
        matcherVersion: MATCHER_VERSION,
        error: describeError(error),
      });
    }
  };

  const handlers = new WorkTaskHandlerRegistry()
    .register(
      SOURCE_COLLECTION_TASK_TYPE,
      createSourceCollectionHandler({
        resolveAdapter,
        collection,
        staleRunSeconds: config.staleRunSeconds,
        acquisitionTimeoutMs: config.acquisitionTimeoutMs,
      }),
    )
    .register(MATCH_SCORING_TASK_TYPE, createMatchScoringHandler({ scoring, logger }));

  const worker = new WorkTaskWorker(
    tasks,
    handlers,
    {
      workerId: config.workerId,
      leaseSeconds: config.leaseSeconds,
      pollIntervalMs: config.pollIntervalMs,
      reaperIntervalMs: config.reaperIntervalMs,
    },
    logger,
  );

  const scheduler = new SourceScheduler(
    { sources: jobSources, sourceRuns, tasks },
    { intervalMs: config.schedulerIntervalMs, staleRunSeconds: config.staleRunSeconds },
    logger,
  );

  let started = false;

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;

      // Recovery before work (SRS 7.6, ENG-025): the scheduler's startup pass reaps runs
      // abandoned by a dead worker *before* its catch-up enqueues anything, and the worker's
      // own lease loop starts with a reap. Both happen before the first task is claimed, so
      // a source wedged by a previous crash is released rather than waiting for a timer.
      await scheduler.start();

      // Then the deploy-level invalidation, still before the first task is claimed, so a
      // changed matcher is already being re-scored by the time the worker accepts work.
      await requestMatcherVersionBackfill();

      await worker.start();
    },

    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      // Order matters: stop scheduling first so no new work is enqueued while the worker
      // unwinds, then let the worker release its in-flight attempt, then close the pool.
      await scheduler.stop();
      await worker.stop();
      await prisma.$disconnect();
    },
  };
}
