import { describeError } from '@application/worker';
import { consoleWorkerLogger } from '@ports/worker-logger';
import { WorkerConfigError, parseWorkerConfig } from './config';
import { createWorkerRuntime, type WorkerRuntime } from './runtime';

/**
 * Production worker entry point (SRS 2.5, 7.2; AC-013, ENG-017).
 *
 * Heavy work runs here, in its own process, and never inside an API request. Start it with
 * `npm run dev:worker` (from source, reloading) or with `npm run build` followed by
 * `npm start:worker` (from `dist`, as `node dist/apps/worker/main.js`).
 *
 * Configuration comes from the environment only (see `.env.example`); an invalid
 * configuration is fatal before anything connects, so a worker never comes up with a guessed
 * bound and then runs for days with the wrong recovery window.
 *
 * Adapters come from the registry in `./adapters` (`PRODUCTION_ADAPTERS`; ADR-0004). It is
 * empty today, because SRS 7.2 requires a source to be approved and its access mechanism
 * recorded *before* a connector exists, and fabricating one would fake provenance. Until
 * then a collection fails permanently with an explicit "no adapter is configured for
 * source <id>", which is visible in the run's error summary rather than silently doing
 * nothing. Adding a source is a registration plus its approval record, not a change here.
 */
async function main(): Promise<void> {
  const config = parseWorkerConfig(process.env);
  const runtime = createWorkerRuntime(config, {});

  installShutdownHandlers(runtime);
  await runtime.start();

  consoleWorkerLogger.info('worker ready', {
    workerId: config.workerId,
    staleRunSeconds: config.staleRunSeconds,
    acquisitionTimeoutMs: config.acquisitionTimeoutMs,
  });
}

/**
 * Stop claiming, release the in-flight attempt and close the pool. It returns the code the
 * process should end with instead of ending the process, so the outcome is observable without
 * taking the caller down as well.
 */
export async function shutdownWorker(runtime: WorkerRuntime): Promise<number> {
  try {
    await runtime.stop();
    return 0;
  } catch (error) {
    consoleWorkerLogger.error('graceful shutdown failed', { error: describeError(error) });
    return 1;
  }
}

/**
 * SIGTERM/SIGINT stop the worker cooperatively: no new work is claimed, the in-flight attempt
 * is released so its lease does not have to expire, and the pool is closed. A second signal
 * exits at once - by then the operator has decided the graceful path is too slow, and holding
 * the process open only delays recovery of its work.
 */
export function installShutdownHandlers(runtime: WorkerRuntime): void {
  let stopping = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      consoleWorkerLogger.warn('second shutdown signal; exiting immediately', { signal });
      process.exit(1);
    }
    stopping = true;
    consoleWorkerLogger.info('shutting down gracefully', { signal });
    void shutdownWorker(runtime).then((code) => {
      if (code === 0) consoleWorkerLogger.info('worker stopped');
      else process.exitCode = code;
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    consoleWorkerLogger.error('worker did not start', {
      configuration: error instanceof WorkerConfigError ? 'invalid' : 'valid',
      error: describeError(error),
    });
    process.exitCode = 1;
  });
}
