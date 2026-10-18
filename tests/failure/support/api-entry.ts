import { parseApiConfig } from '@app/api/config';
import { startApi } from '@app/api/main';
import { requireTestDatabaseUrl } from '../../support/db';

/**
 * Test entry point for the process-lifecycle test (AC-014, ENG-017).
 *
 * It runs the real `startApi` composition - build, bind and the SIGTERM/SIGINT wiring - against
 * TEST_DATABASE_URL. The only difference from `apps/api/main.ts` is that the signal is raised
 * here instead of by an operator: Windows cannot deliver a signal to a child process
 * (`kill()` terminates it outright), so the shutdown signal is emitted in-process. Everything
 * it reaches is the production path, and the process's own exit code becomes observable.
 */
async function main(): Promise<void> {
  const config = parseApiConfig({
    ...process.env,
    DATABASE_URL: requireTestDatabaseUrl(),
    API_HOST: '127.0.0.1',
  });

  await startApi(config);
  // Printed before any signal, so the parent can tell "ready" from "never started".
  console.log(`test api ready port=${config.port}`);

  const shutdownAfterMs = Number(process.env.FAILURE_SHUTDOWN_AFTER_MS ?? 300);
  setTimeout(() => process.emit('SIGTERM'), shutdownAfterMs);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
