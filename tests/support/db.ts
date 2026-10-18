import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadDotEnv } from './load-env';

loadDotEnv();

const PRISMA_CLI = join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');
const PRISMA_SCHEMA = join('prisma', 'schema.prisma');

/**
 * Real-database integration tests run against TEST_DATABASE_URL. We never fall
 * back to DATABASE_URL for setup, because that could wipe a developer's
 * working database.
 */
export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env and point it at a disposable database.',
    );
  }
  return url;
}

/**
 * Apply versioned migrations to the test database. Uses `prisma migrate deploy`
 * so integration tests exercise the exact SQL shipped to production, including
 * hand-written statements the Prisma schema cannot express.
 */
export function applyTestMigrations(): void {
  if (!existsSync(PRISMA_CLI)) {
    throw new Error('Prisma CLI not found. Run `npm install` first.');
  }
  execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--schema', PRISMA_SCHEMA], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: requireTestDatabaseUrl() },
  });
}

export function createTestPrismaClient(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: requireTestDatabaseUrl() } },
  });
}

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "work_tasks", "jobs", "raw_jobs", "source_runs", "job_sources", "system_logs", "location_preferences", "target_roles", "candidate_skills", "candidate_profiles", "users" RESTART IDENTITY CASCADE',
  );
}
