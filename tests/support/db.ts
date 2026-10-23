import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadDotEnv } from './load-env';

loadDotEnv();

const PRISMA_CLI = join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');
const PRISMA_SCHEMA = join('prisma', 'schema.prisma');

/** A test database must be named so that a mistaken reset cannot destroy real data. */
const DISPOSABLE_DATABASE_SUFFIX = '_test';

function refuse(reason: string): never {
  throw new Error(
    `Refusing to run tests: TEST_DATABASE_URL ${reason}. ` +
      'Tests migrate and TRUNCATE that database, so point TEST_DATABASE_URL at a dedicated ' +
      `disposable PostgreSQL database whose name ends in "${DISPOSABLE_DATABASE_SUFFIX}" ` +
      '(see .env.example).',
  );
}

/**
 * Fail closed unless `url` names a dedicated disposable PostgreSQL database.
 *
 * `truncateAll()` empties every application table, so a `TEST_DATABASE_URL` that
 * points at an ordinary development database destroys real data. A `file:` URL or
 * merely "some PostgreSQL URL" is not evidence of disposability; the database name
 * is. Every destructive helper calls `requireTestDatabaseUrl()` first, so a rejected
 * URL never reaches a Prisma process.
 *
 * The URL itself is never echoed: it carries credentials. The `_test` suffix is the
 * whole policy; the host is deliberately not checked, so CI and container databases
 * keep working. Any database named `*_test`, on any host, is accepted.
 */
export function assertDisposableTestDatabase(url: string): void {
  if (!url) refuse('is empty');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    refuse('is not a valid URL');
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    refuse(`uses the "${parsed.protocol}" scheme, and tests only run against PostgreSQL`);
  }

  const name = parsed.pathname.replace(/^\/+/, '');
  if (!name) refuse('does not name a database');
  if (!name.endsWith(DISPOSABLE_DATABASE_SUFFIX)) {
    refuse(
      `names the database "${name}", which is not marked disposable: ` +
        `the name must end in "${DISPOSABLE_DATABASE_SUFFIX}"`,
    );
  }
}

/**
 * Real-database integration tests run against TEST_DATABASE_URL. We never fall
 * back to DATABASE_URL for setup, because that could wipe a developer's
 * working database, and the URL must pass `assertDisposableTestDatabase` before
 * any migration or truncation runs.
 */
export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env and point it at a dedicated ' +
        'disposable database whose name ends in "_test".',
    );
  }
  assertDisposableTestDatabase(url);
  return url;
}

/**
 * Apply versioned migrations to the test database. Uses `prisma migrate deploy`
 * so integration tests exercise the exact SQL shipped to production, including
 * hand-written statements the Prisma schema cannot express.
 */
export function applyTestMigrations(): void {
  // Validate before anything else, so an unsafe URL reports the safety error even
  // in a checkout where the CLI check below would also fail.
  const databaseUrl = requireTestDatabaseUrl();
  if (!existsSync(PRISMA_CLI)) {
    throw new Error('Prisma CLI not found. Run `npm install` first.');
  }
  execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--schema', PRISMA_SCHEMA], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

export function createTestPrismaClient(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: requireTestDatabaseUrl() } },
  });
}

/**
 * Empty every application table.
 *
 * Re-validates TEST_DATABASE_URL first, so a client obtained some other way cannot
 * be used to wipe data after the configuration turned unsafe. The client itself
 * cannot be inspected, so callers must build it with `createTestPrismaClient()`.
 */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  requireTestDatabaseUrl();
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "notification_feedback", "notification_outbox", "job_matches", "work_tasks", "jobs", "raw_jobs", "source_runs", "job_sources", "system_logs", "location_preferences", "target_roles", "candidate_skills", "candidate_profiles", "users" RESTART IDENTITY CASCADE',
  );
}
