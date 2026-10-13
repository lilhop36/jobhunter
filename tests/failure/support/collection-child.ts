import { PrismaClient } from '@prisma/client';
import { WorkTaskHandlerRegistry, WorkTaskWorker } from '@application/worker';
import { PrismaWorkTaskRepository } from '@infrastructure/work-tasks/prisma-work-task-repository';
import {
  COLLECTION_BLOCKING_IDENTIFIER,
  COLLECTION_KILLED_WORKER_ID,
  COLLECTION_TASK_TYPE,
  createCollectionHandler,
} from './collection-fixtures';
import { KILLED_WORKER_HEARTBEAT_MS, KILLED_WORKER_LEASE_SECONDS } from './failure-fixtures';

/**
 * Child-process harness for the collection crash test.
 *
 * Runs the REAL worker and the REAL `RunSourceCollection` against
 * TEST_DATABASE_URL, with an adapter that blocks forever at a deterministic point
 * inside the record loop. The parent test waits for the resulting durable
 * mid-collection state and then kills this process outright.
 *
 * This is a test fixture, not a production entrypoint. It registers no cleanup
 * handler on purpose: an abrupt kill must leave the durable state exactly as a
 * crashed worker would - an active SourceRun with partial evidence, and a claimed
 * work task whose lease is never released.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

  const workerId = process.env.FAILURE_WORKER_ID ?? COLLECTION_KILLED_WORKER_ID;
  const leaseSeconds = Number(process.env.FAILURE_LEASE_SECONDS ?? KILLED_WORKER_LEASE_SECONDS);
  const heartbeatIntervalMs = Number(
    process.env.FAILURE_HEARTBEAT_MS ?? KILLED_WORKER_HEARTBEAT_MS,
  );

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  const handlers = new WorkTaskHandlerRegistry().register(
    COLLECTION_TASK_TYPE,
    createCollectionHandler(prisma, COLLECTION_BLOCKING_IDENTIFIER),
  );

  const worker = new WorkTaskWorker(new PrismaWorkTaskRepository(prisma), handlers, {
    workerId,
    leaseSeconds,
    heartbeatIntervalMs,
    pollIntervalMs: 100,
    // The child must never reap its own attempt; recovery is the parent's job.
    reaperIntervalMs: 60_000,
  });

  // Announce readiness only once the database is reachable, so the parent's state
  // polling cannot race the connection handshake.
  await prisma.$queryRaw`SELECT 1`;
  process.stdout.write(`READY ${workerId}\n`);
  await worker.start();
}

void main().catch((error: unknown) => {
  process.stderr.write(`collection-child harness failed: ${String(error)}\n`);
  process.exit(1);
});
