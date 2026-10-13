import { PrismaClient } from '@prisma/client';
import { WorkTaskHandlerRegistry, WorkTaskWorker } from '@application/worker';
import { PrismaWorkTaskRepository } from '@infrastructure/work-tasks/prisma-work-task-repository';
import { BLOCKING_TASK_TYPE, KILLED_WORKER_HEARTBEAT_MS, KILLED_WORKER_LEASE_SECONDS } from './failure-fixtures';

/**
 * Child-process harness for the abrupt-kill failure test (AC-014, ENG-031).
 *
 * Runs the REAL worker against TEST_DATABASE_URL with a handler that never
 * completes, so the claimed task stays RUNNING for as long as this process lives
 * (heartbeats keep the lease renewed). The parent test waits for that durable
 * state and then kills this process outright.
 *
 * This is a test fixture, not a production entrypoint. It performs no cleanup
 * handler registration on purpose: an abrupt kill must leave the durable state
 * exactly as a crashed worker would.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

  const workerId = process.env.FAILURE_WORKER_ID ?? 'failure-child';
  const leaseSeconds = Number(process.env.FAILURE_LEASE_SECONDS ?? KILLED_WORKER_LEASE_SECONDS);
  const heartbeatIntervalMs = Number(
    process.env.FAILURE_HEARTBEAT_MS ?? KILLED_WORKER_HEARTBEAT_MS,
  );

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  const handlers = new WorkTaskHandlerRegistry().register(BLOCKING_TASK_TYPE, () =>
    // Never settles: only the parent's SIGKILL ends this attempt.
    new Promise<void>(() => {}),
  );

  const worker = new WorkTaskWorker(
    new PrismaWorkTaskRepository(prisma),
    handlers,
    {
      workerId,
      leaseSeconds,
      heartbeatIntervalMs,
      pollIntervalMs: 100,
      // The child must never reap its own attempt; recovery is the parent's job.
      reaperIntervalMs: 60_000,
    },
  );

  // Announce readiness only once the database is reachable, so the parent's
  // state polling cannot race the connection handshake.
  await prisma.$queryRaw`SELECT 1`;
  process.stdout.write(`READY ${workerId}\n`);
  await worker.start();
}

void main().catch((error: unknown) => {
  process.stderr.write(`worker-child harness failed: ${String(error)}\n`);
  process.exit(1);
});
