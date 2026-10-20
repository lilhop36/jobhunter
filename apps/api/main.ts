import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { PrismaJobMatchRepository } from '@infrastructure/ingestion/prisma-job-match-repository';
import { PrismaJobReader } from '@infrastructure/ingestion/prisma-job-reader';
import { PrismaJobSourceRepository } from '@infrastructure/ingestion/prisma-job-source-repository';
import { PrismaCandidateProfileRepository } from '@infrastructure/ingestion/prisma-candidate-profile-repository';
import { PrismaNotificationRepository } from '@infrastructure/matching/prisma-notification-repository';
import { PrismaWorkTaskRepository } from '@infrastructure/work-tasks/prisma-work-task-repository';
import { RequestMatchBackfill } from '@application/matching';
import type { WorkerLogger } from '@ports/worker-logger';
import { ApiConfig, ApiConfigError, parseApiConfig } from './config';
import { registerErrorHandler } from './errors';
import { registerJobRoutes } from './routes/jobs';
import { registerMatchRoutes } from './routes/matches';
import { registerNotificationRoutes } from './routes/notifications';
import { registerProfileRoutes } from './routes/profile';
import { registerSourceRoutes } from './routes/sources';

/**
 * API process composition root (SRS 3.4; AC-014, AC-018).
 *
 * The API is its own process and never does heavy work in a request: `POST
 * /api/sources/:id/run` only enqueues, and the worker picks the task up. That is what keeps
 * a slow collection from occupying a request thread.
 *
 * Start it with `npm run dev:api` (from source, reloading) or with `npm run build` followed
 * by `npm start:api` (from `dist`). Configuration comes from the environment, read once here.
 */

export interface ApiApp {
  app: FastifyInstance;
  prisma: PrismaClient;
}

/**
 * Build the app without binding a port, so tests can drive it with `app.inject()` and own the
 * database lifecycle. Signal handling belongs to `startApi`, not here: every `buildApi` call
 * installing process listeners would leak one per test and end the process by accident.
 */
export async function buildApi(config: ApiConfig): Promise<ApiApp> {
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info' },
  });

  registerErrorHandler(app);

  app.get('/health', async () => ({ status: 'ok' }));

  await registerSourceRoutes(app, {
    sources: new PrismaJobSourceRepository(prisma),
    workTasks: new PrismaWorkTaskRepository(prisma),
  });

  await registerMatchRoutes(app, {
    matches: new PrismaJobMatchRepository(prisma),
  });

  await registerJobRoutes(app, {
    jobs: new PrismaJobReader(prisma),
  });

  await registerNotificationRoutes(app, {
    notifications: new PrismaNotificationRepository(prisma),
  });

  // The worker's logger interface, over Fastify's logger: one logging configuration per process,
  // and silent under `NODE_ENV=test` like every other line the app writes.
  const logger: WorkerLogger = {
    info: (message, meta) => app.log.info({ meta }, message),
    warn: (message, meta) => app.log.warn({ meta }, message),
    error: (message, meta) => app.log.error({ meta }, message),
  };

  await registerProfileRoutes(app, {
    profiles: new PrismaCandidateProfileRepository(prisma),
    rescore: new RequestMatchBackfill({
      sources: new PrismaJobSourceRepository(prisma),
      tasks: new PrismaWorkTaskRepository(prisma),
      logger,
    }),
  });

  return { app, prisma };
}

/**
 * Build, bind and wire shutdown: everything the process does apart from reading the
 * environment. Split out of `main` so the process-lifecycle test can start the real
 * composition in its own process rather than a hand-assembled imitation.
 */
export async function startApi(config: ApiConfig): Promise<ApiApp> {
  const api = await buildApi(config);
  await api.app.listen({ host: config.host, port: config.port });
  installShutdownHandlers(api);
  return api;
}

/**
 * Stop accepting connections, let the requests already in flight finish, then close the pool.
 *
 * It returns the code the process should end with instead of ending the process, so the
 * outcome is observable without taking the caller down as well. The signal handler is the only
 * caller that turns the result into an exit code.
 */
export async function shutdownApi(api: ApiApp): Promise<number> {
  try {
    await api.app.close();
    await api.prisma.$disconnect();
    return 0;
  } catch (error) {
    api.app.log.error({ err: error }, 'API shutdown failed');
    return 1;
  }
}

/**
 * SIGTERM/SIGINT stop the API cooperatively: no new request is accepted, in-flight ones are
 * allowed to finish, and the database pool is closed. Nothing forces an exit, because closing
 * the listener and the pool leaves no handle behind - the process ends on its own, with the
 * code this handler sets. A repeat of the same signal finds no listener and terminates at
 * once, which is what an operator signalling twice is asking for.
 */
function installShutdownHandlers(api: ApiApp): void {
  const shutdown = (signal: NodeJS.Signals): void => {
    api.app.log.info({ signal }, 'Shutting down API server');
    void shutdownApi(api).then((code) => {
      if (code !== 0) process.exitCode = code;
    });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

async function main(): Promise<void> {
  let config: ApiConfig;
  try {
    config = parseApiConfig(process.env);
  } catch (error) {
    console.error(error instanceof ApiConfigError ? error.message : error);
    process.exit(1);
  }

  await startApi(config);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    // Reached when the process cannot start at all: bad configuration is reported above,
    // this is everything else (an occupied port, an unreachable database). A non-zero exit
    // is what stops a supervisor from waiting for it.
    console.error(`API did not start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
