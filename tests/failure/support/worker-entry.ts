import { parseWorkerConfig } from '@app/worker/config';
import { installShutdownHandlers } from '@app/worker/main';
import { createWorkerRuntime } from '@app/worker/runtime';
import { requireTestDatabaseUrl } from '../../support/db';
import { makeCollectionAdapter } from './collection-fixtures';

/**
 * Test entry point for the failure tests (AC-014, ENG-017).
 *
 * It runs the REAL worker runtime: `parseWorkerConfig`, the composition root, the worker
 * loop, the scheduler, the startup reaper, the collection handler and the shutdown wiring
 * from `apps/worker/main.ts`. The only difference from the production entry point is
 * `resolveAdapter`, which registers the shared fake adapter instead of returning null.
 *
 * That difference is the point. A hand-assembled child would prove a worker *class* works,
 * but not that the process production actually starts does - a handler that is never
 * registered, a scheduler that is never started, a configuration bound that is ignored or a
 * signal that is never wired would all pass such a test. The failure tests must be able to
 * break the entry point.
 */
async function main(): Promise<void> {
  const sourceId = process.env.FAILURE_SOURCE_ID;
  if (!sourceId) throw new Error('FAILURE_SOURCE_ID is required');

  // `null` means "the block is lifted": the recovery process re-runs the same records and
  // simply completes, which is how the retry is proven to exercise the same pipeline.
  const blockOn = process.env.FAILURE_BLOCK_ON ?? null;

  const config = parseWorkerConfig({ ...process.env, DATABASE_URL: requireTestDatabaseUrl() });
  const runtime = createWorkerRuntime(config, {
    resolveAdapter: async (requested) =>
      requested === sourceId ? makeCollectionAdapter(sourceId, blockOn) : null,
  });

  installShutdownHandlers(runtime);
  await runtime.start();
  // Diagnostics for the parent test, which never talks to the child except through the
  // database.
  console.log(`test worker ready workerId=${config.workerId} sourceId=${sourceId} blockOn=${String(blockOn)}`);

  // Signals cannot be delivered to a child process on Windows (`kill()` terminates it
  // outright), so the lifecycle test asks the entry to raise its own shutdown signal;
  // everything the signal reaches is the production wiring. Off unless asked for, so the
  // crash tests keep killing this process without any cleanup running.
  const shutdownAfterMs = Number(process.env.FAILURE_SHUTDOWN_AFTER_MS ?? 0);
  if (shutdownAfterMs > 0) setTimeout(() => process.emit('SIGTERM'), shutdownAfterMs);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
