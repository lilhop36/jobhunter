import type { FastifyInstance } from 'fastify';
import { HealthStatus, SourceRunStatus, SourceRunTrigger } from '@domain/enums';
import { SOURCE_COLLECTION_TASK_TYPE, sourceCollectionDedupeKey } from '@application/ingestion';
import type {
  JobSourceRepository,
  RunHistoryCursor,
  SourceCursor,
  SourceDetail,
  SourceRunSummary,
} from '@ports/job-source-repository';
import type { WorkTaskRepository } from '@ports/work-task-repository';
import type { WorkTaskRecord } from '@domain/types';
import { ApiError } from '../errors';
import { listRunsQuery, listSourcesQuery, sourceIdParams } from '../schemas';

/**
 * The four Phase 1 source routes (SRS 3.4).
 *
 * Only `GET /api/sources` and `POST /api/sources/:id/run` appear in the SRS endpoint table,
 * and the SRS fixes no response body for either. The shapes below are therefore *proposed*:
 * the SRS 5.2 JobSource attributes, plus the latest run, plus a `pagination` object shared by
 * both list endpoints. `accessPolicy` is deliberately not published — it records the approved
 * access mechanism, is not needed to report health, and the API has no authentication.
 */
export interface SourceRoutesDeps {
  sources: JobSourceRepository;
  workTasks: WorkTaskRepository;
}

const DEFAULT_LIMIT = 20;

export async function registerSourceRoutes(
  app: FastifyInstance,
  deps: SourceRoutesDeps,
): Promise<void> {
  app.get('/api/sources', { schema: { querystring: listSourcesQuery } }, async (request) => {
    const query = request.query as {
      includeDisabled?: boolean;
      healthStatus?: HealthStatus;
      cursor?: string;
      limit?: number;
    };

    const page = await deps.sources.listSources({
      includeDisabled: query.includeDisabled ?? false,
      ...(query.healthStatus === undefined ? {} : { healthStatus: query.healthStatus }),
      ...(query.cursor === undefined ? {} : { cursor: decodeSourceCursor(query.cursor) }),
      limit: query.limit ?? DEFAULT_LIMIT,
    });

    return {
      sources: page.sources.map(serializeSource),
      pagination: { nextCursor: page.nextCursor && encodeCursor(page.nextCursor) },
    };
  });

  app.get('/api/sources/:id', { schema: { params: sourceIdParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const source = await deps.sources.findById(id);
    if (source === null) throw ApiError.notFound(`Source ${id} was not found`);
    return serializeSource(source);
  });

  app.get(
    '/api/sources/:id/runs',
    { schema: { params: sourceIdParams, querystring: listRunsQuery } },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as {
        status?: SourceRunStatus;
        trigger?: SourceRunTrigger;
        cursor?: string;
        limit?: number;
      };

      // An unknown source is a 404, not an empty history: `[]` would suggest the source
      // exists and has simply never run.
      if ((await deps.sources.findById(id)) === null) {
        throw ApiError.notFound(`Source ${id} was not found`);
      }

      const page = await deps.sources.listRuns(id, {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.trigger === undefined ? {} : { trigger: query.trigger }),
        ...(query.cursor === undefined ? {} : { cursor: decodeRunCursor(query.cursor) }),
        limit: query.limit ?? DEFAULT_LIMIT,
      });

      return {
        runs: page.runs.map(serializeRun),
        pagination: { nextCursor: page.nextCursor && encodeCursor(page.nextCursor) },
      };
    },
  );

  app.post(
    '/api/sources/:id/run',
    { schema: { params: sourceIdParams } },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const source = await deps.sources.findById(id);
      if (source === null) throw ApiError.notFound(`Source ${id} was not found`);

      // ADR-0003 / SRS 3.4: `enabled` is an operator opt-in, not merely a scheduling flag. A
      // disabled source is out of service and must not be collected by any path, so this is
      // checked *before* the active-run conflict: enablement decides whether a run may start
      // at all, whereas the active-run check is about not starting a second one.
      if (!source.enabled) {
        throw ApiError.sourceDisabled(id);
      }

      // SRS 3.4: a source that is already active is a conflict. Two things mean "active", and
      // both are needed:
      //
      //   1. a RUNNING run. `one_active_run_per_source` allows only one, so a RUNNING run is
      //      always the latest one, and starting another run would violate that index. This
      //      also catches a run orphaned by a crashed worker before its task was reclaimed.
      //   2. an active (PENDING/RUNNING) collection task, enforced atomically below.
      //
      // (1) is a read, so it is technically racy; that is acceptable because it cannot create
      // a duplicate: (2) is the atomic half. If a run starts between the read and the enqueue,
      // only a task is enqueued — no second run — and `RunSourceCollection` then refuses to
      // start a run for a source that already has one.
      if (source.latestRun?.status === SourceRunStatus.RUNNING) {
        throw ApiError.sourceRunActive(id);
      }

      // `created: false` means an active collection already held this source's dedupe key, so
      // no second collection was started and the answer is 409. Retry and priority stay at the
      // queue defaults — a manual run changes the trigger, not the retry policy.
      const result = await deps.workTasks.enqueueOrConflict({
        type: SOURCE_COLLECTION_TASK_TYPE,
        payload: { sourceId: id, trigger: SourceRunTrigger.MANUAL },
        dedupeKey: sourceCollectionDedupeKey(id),
      });

      if (!result.created) throw ApiError.sourceRunActive(id);

      return reply.code(202).send({ task: serializeTask(result.task) });
    },
  );
}

function serializeSource(source: SourceDetail) {
  return {
    id: source.id,
    name: source.name,
    adapterType: source.adapterType,
    adapterVersion: source.adapterVersion,
    enabled: source.enabled,
    schedule: source.schedule,
    healthStatus: source.healthStatus,
    lastSuccessfulRunAt: asIso(source.lastSuccessfulRunAt),
    lastErrorAt: asIso(source.lastErrorAt),
    latestRun: source.latestRun === null ? null : serializeRun(source.latestRun),
  };
}

function serializeRun(run: SourceRunSummary) {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    startedAt: run.startedAt.toISOString(),
    finishedAt: asIso(run.finishedAt),
    durationMs: run.durationMs,
    jobsDiscovered: run.jobsDiscovered,
    jobsAccepted: run.jobsAccepted,
    jobsDuplicate: run.jobsDuplicate,
    jobsRejected: run.jobsRejected,
    undeduplicable: run.undeduplicable,
    fallbackIdentities: run.fallbackIdentities,
    parseFailures: run.parseFailures,
    httpFailures: run.httpFailures,
    unexpectedZeroResults: run.unexpectedZeroResults,
    enrichmentScheduled: run.enrichmentScheduled,
    errorSummary: run.errorSummary,
  };
}

/** The enqueued task, minus the lease and lock columns that belong to the worker. */
function serializeTask(task: WorkTaskRecord) {
  return {
    id: task.id,
    type: task.type,
    status: task.status,
    dedupeKey: task.dedupeKey,
    priority: task.priority,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    runAfter: task.runAfter.toISOString(),
    createdAt: task.createdAt.toISOString(),
  };
}

function asIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * A cursor is opaque: base64url of the keyset tuple. The tuple is encoded as JSON rather than
 * joined on a delimiter so that a value containing the delimiter (a source name, say) cannot
 * corrupt it. A malformed cursor is a 400 — the client sent it, so the client is told.
 */
function encodeCursor(tuple: SourceCursor | RunHistoryCursor): string {
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

function decodeSourceCursor(raw: string): SourceCursor {
  const value = decodeCursor(raw);
  if (value === null || typeof value.name !== 'string' || value.name === '') {
    throw invalidCursor();
  }
  return { name: value.name };
}

function decodeRunCursor(raw: string): RunHistoryCursor {
  const value = decodeCursor(raw);
  if (value === null || typeof value.id !== 'string' || typeof value.startedAt !== 'string') {
    throw invalidCursor();
  }
  const startedAt = new Date(value.startedAt);
  if (Number.isNaN(startedAt.getTime())) throw invalidCursor();
  return { startedAt, id: value.id };
}

function decodeCursor(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function invalidCursor(): ApiError {
  return ApiError.validation('The pagination cursor is not valid');
}
