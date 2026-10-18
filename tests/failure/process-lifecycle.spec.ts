import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTestMigrations, createTestPrismaClient, requireTestDatabaseUrl, truncateAll } from '../support/db';

/**
 * Process lifecycle: startup validation and graceful shutdown (ENG-017, AC-014).
 *
 * These are the properties that only exist at the process level, so every case here starts a
 * real entry point as its own process. A test that called `parseApiConfig` directly would not
 * show that a misconfigured process reports the problem and exits non-zero; a test that
 * hand-assembled an app would not show that the process production starts tears down cleanly.
 *
 * Graceful shutdown is provoked differently, and that is a platform fact rather than a
 * shortcut: on Windows `child.kill()` terminates a child outright (libuv calls
 * TerminateProcess), so no signal handler in the child ever runs. The child therefore raises
 * its own shutdown signal - see `support/api-entry.ts` and `support/worker-entry.ts` - and
 * everything the signal reaches is the production wiring, including the process's exit code.
 */

const API_ENTRY = join(process.cwd(), 'apps', 'api', 'main.ts');
const WORKER_ENTRY = join(process.cwd(), 'apps', 'worker', 'main.ts');
const API_HARNESS = join(process.cwd(), 'tests', 'failure', 'support', 'api-entry.ts');
const WORKER_HARNESS = join(process.cwd(), 'tests', 'failure', 'support', 'worker-entry.ts');

interface StartedProcess {
  proc: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Everything the child printed, for failure messages. */
  output: () => string;
}

const children: ChildProcess[] = [];
const prisma = createTestPrismaClient();

/**
 * Start a TypeScript entry point with tsx, the same runner the `dev:*` scripts use, so the
 * process under test resolves `@app/*` exactly as it does in development and production
 * (`tsc-alias` rewrites the same imports for the `dist` build).
 */
function startProcess(entry: string, env: NodeJS.ProcessEnv = {}): StartedProcess {
  const log: string[] = [];
  const proc = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const capture = (stream: string) => (chunk: Buffer) => {
    log.push(`[${stream}] ${chunk.toString().trimEnd()}`);
  };
  proc.stdout?.on('data', capture('stdout'));
  proc.stderr?.on('data', capture('stderr'));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal }));
  });

  children.push(proc);
  return { proc, exited, output: () => (log.length === 0 ? '(the process printed nothing)' : log.join('\n')) };
}

/** Configuration with the named variables removed, so "missing" is genuinely missing. */
function withoutEnv(...names: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of names) delete env[name];
  return env;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not allocate a port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

beforeAll(() => {
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

afterEach(async () => {
  const running = children.splice(0, children.length);
  for (const proc of running) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  await Promise.all(
    running.map((proc) =>
      Promise.race([
        new Promise<void>((resolve) => proc.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]),
    ),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('process startup refuses invalid configuration', () => {
  it('fails the API process when API_PORT is not a valid port', { timeout: 60_000 }, async () => {
    const started = startProcess(API_ENTRY, { ...process.env, API_PORT: '70000' });
    const exit = await started.exited;

    expect(exit.code).toBe(1);
    expect(started.output()).toContain('API_PORT must be an integer between 1 and 65535');
  });

  it('fails the worker when a required safety bound is absent', async () => {
    const started = startProcess(
      WORKER_ENTRY,
      withoutEnv('SOURCE_STALE_RUN_SECONDS', 'SOURCE_ACQUISITION_TIMEOUT_MS'),
    );
    const exit = await started.exited;

    expect(exit.code).toBe(1);
    expect(started.output()).toContain('SOURCE_STALE_RUN_SECONDS is required');
  }, 60_000);

  it('refuses an acquisition bound that outlives the stale-run bound', async () => {
    const started = startProcess(WORKER_ENTRY, {
      ...process.env,
      SOURCE_STALE_RUN_SECONDS: '1',
      SOURCE_ACQUISITION_TIMEOUT_MS: '5000',
    });
    const exit = await started.exited;

    expect(exit.code).toBe(1);
    const output = started.output();
    expect(output).toContain('SOURCE_ACQUISITION_TIMEOUT_MS');
    expect(output).toContain('SOURCE_STALE_RUN_SECONDS');
  }, 60_000);

  it('refuses a heartbeat that outlives its lease', async () => {
    const started = startProcess(WORKER_ENTRY, {
      ...process.env,
      SOURCE_STALE_RUN_SECONDS: '60',
      SOURCE_ACQUISITION_TIMEOUT_MS: '1000',
      WORKER_LEASE_SECONDS: '1',
      WORKER_HEARTBEAT_MS: '5000',
    });
    const exit = await started.exited;

    expect(exit.code).toBe(1);
    expect(started.output()).toContain('WORKER_HEARTBEAT_MS');
  }, 60_000);
});

describe('graceful shutdown (AC-014)', () => {
  it('SIGTERM stops accepting requests and the API process exits 0', async () => {
    const port = await freePort();
    const started = startProcess(API_HARNESS, {
      ...process.env,
      NODE_ENV: 'development',
      API_PORT: String(port),
      FAILURE_SHUTDOWN_AFTER_MS: '500',
    });

    const exit = await started.exited;
    const output = started.output();

    // No signal: the graceful path closed the listener and the pool, and the process ran out
    // of work on its own instead of having to be killed.
    expect(output).toContain(`test api ready port=${port}`);
    expect(output).toContain('Shutting down API server');
    expect(exit.signal).toBeNull();
    expect(exit.code, output).toBe(0);
  }, 60_000);

  it('SIGTERM stops the worker loop and the worker process exits 0', async () => {
    const started = startProcess(WORKER_HARNESS, {
      ...process.env,
      TEST_DATABASE_URL: requireTestDatabaseUrl(),
      FAILURE_SOURCE_ID: '00000000-0000-0000-0000-0000000000ff',
      FAILURE_SHUTDOWN_AFTER_MS: '500',
      WORKER_ID: 'lifecycle-worker',
      WORKER_POLL_INTERVAL_MS: '50',
      SOURCE_STALE_RUN_SECONDS: '5',
      SOURCE_ACQUISITION_TIMEOUT_MS: '1000',
    });

    const exit = await started.exited;
    const output = started.output();

    expect(output).toContain('test worker ready');
    expect(output).toContain('shutting down gracefully');
    expect(output).toContain('worker stopped');
    expect(exit.signal).toBeNull();
    expect(exit.code, output).toBe(0);
  }, 60_000);
});
