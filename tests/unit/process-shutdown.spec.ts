import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { shutdownApi } from '../../apps/api/main';
import { shutdownWorker } from '../../apps/worker/main';
import type { WorkerRuntime } from '../../apps/worker/runtime';

/**
 * Shutdown outcome as a value, not as an exit (ENG-017).
 *
 * The process-level tests in `tests/failure/process-lifecycle.spec.ts` prove the happy path
 * ends a real process with code 0; the failure path cannot be provoked there without a broken
 * database. Both entry points return the code instead of ending the process, which is what
 * makes "a shutdown that failed is reported with a non-zero code" testable at all.
 */

function fakeApp(close: () => Promise<void>): {
  app: FastifyInstance;
  prisma: PrismaClient;
  disconnect: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
} {
  const disconnect = vi.fn(async () => undefined);
  const logError = vi.fn();
  return {
    app: { close, log: { error: logError } } as unknown as FastifyInstance,
    prisma: { $disconnect: disconnect } as unknown as PrismaClient,
    disconnect,
    logError,
  };
}

function fakeRuntime(stop: () => Promise<void>): WorkerRuntime {
  return { start: async () => undefined, stop } as unknown as WorkerRuntime;
}

describe('shutdownApi', () => {
  it('closes the listener and the pool, and reports success', async () => {
    const close = vi.fn(async () => undefined);
    const { app, prisma, disconnect } = fakeApp(close);

    await expect(shutdownApi({ app, prisma })).resolves.toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('reports a failed close as a non-zero code instead of throwing', async () => {
    const failure = new Error('the connection pool is gone');
    const { app, prisma, logError } = fakeApp(async () => {
      throw failure;
    });

    await expect(shutdownApi({ app, prisma })).resolves.toBe(1);
    expect(logError).toHaveBeenCalledWith({ err: failure }, 'API shutdown failed');
  });

  it('reports a failed disconnect as a non-zero code', async () => {
    const { app, prisma, disconnect, logError } = fakeApp(async () => undefined);
    disconnect.mockRejectedValueOnce(new Error('pool refused to close'));

    await expect(shutdownApi({ app, prisma })).resolves.toBe(1);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});

describe('shutdownWorker', () => {
  it('stops the runtime and reports success', async () => {
    const stop = vi.fn(async () => undefined);

    await expect(shutdownWorker(fakeRuntime(stop))).resolves.toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('reports a failed stop as a non-zero code instead of throwing', async () => {
    await expect(
      shutdownWorker(
        fakeRuntime(async () => {
          throw new Error('the worker refused to stop');
        }),
      ),
    ).resolves.toBe(1);
  });
});
