import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  applyTestMigrations,
  assertDisposableTestDatabase,
  createTestPrismaClient,
  requireTestDatabaseUrl,
  truncateAll,
} from '../support/db';

/**
 * `applyTestMigrations` shells out to the Prisma CLI, which can apply migrations
 * and is followed by `truncateAll()`. These tests never let it reach a database:
 * the only thing that could invoke the CLI is mocked, so a rejected URL is proven
 * to fail before any Prisma process exists.
 */
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

/** A dedicated disposable database: the only shape the guard accepts. */
const SAFE = 'postgresql://user:secret@localhost:5432/jobhunter_test?schema=public';
/** An ordinary development database. */
const DEVELOPMENT = 'postgresql://user:secret@localhost:5432/jobhunter?schema=public';

afterEach(() => {
  vi.unstubAllEnvs();
  execFileSyncMock.mockReset();
});

describe('assertDisposableTestDatabase', () => {
  it('accepts a dedicated postgres test database', () => {
    expect(() => assertDisposableTestDatabase(SAFE)).not.toThrow();
    expect(() => assertDisposableTestDatabase('postgres://u:p@db:5432/other_test')).not.toThrow();
  });

  it('rejects an ordinary development database', () => {
    expect(() => assertDisposableTestDatabase(DEVELOPMENT)).toThrow(/not marked disposable/);
  });

  it('rejects a SQLite file URL', () => {
    expect(() => assertDisposableTestDatabase('file:./dev.db')).toThrow(/only run against PostgreSQL/);
  });

  it('rejects a PostgreSQL URL that names no database', () => {
    expect(() => assertDisposableTestDatabase('postgresql://u:p@localhost:5432')).toThrow(
      /does not name a database/,
    );
  });

  it('rejects an empty or unparseable configuration', () => {
    expect(() => assertDisposableTestDatabase('')).toThrow(/is empty/);
    expect(() => assertDisposableTestDatabase('not a url')).toThrow(/is not a valid URL/);
  });

  it('never echoes credentials in its error', () => {
    let message: string | null = null;
    try {
      assertDisposableTestDatabase(DEVELOPMENT);
    } catch (error) {
      message = String((error as Error).message);
    }
    // If the guard ever stops rejecting, `message` stays null and this fails.
    expect(message).not.toBeNull();
    expect(message).not.toContain('secret');
    expect(message).not.toContain('postgresql://');
  });
});

describe('requireTestDatabaseUrl', () => {
  it('fails safely when TEST_DATABASE_URL is missing', () => {
    vi.stubEnv('TEST_DATABASE_URL', '');
    expect(() => requireTestDatabaseUrl()).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it('rejects the development database', () => {
    vi.stubEnv('TEST_DATABASE_URL', DEVELOPMENT);
    expect(() => requireTestDatabaseUrl()).toThrow(/not marked disposable/);
  });

  it('accepts the dedicated test database', () => {
    vi.stubEnv('TEST_DATABASE_URL', SAFE);
    expect(requireTestDatabaseUrl()).toBe(SAFE);
  });
});

describe('applyTestMigrations', () => {
  it('runs no Prisma process when the configuration is unsafe', () => {
    vi.stubEnv('TEST_DATABASE_URL', DEVELOPMENT);

    expect(() => applyTestMigrations()).toThrow(/not marked disposable/);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('runs migrate deploy for a disposable database', () => {
    vi.stubEnv('TEST_DATABASE_URL', SAFE);

    applyTestMigrations();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0][1]).toContain('deploy');
    // The validated URL must be the one Prisma receives: without this override the CLI
    // would read the developer's `.env` DATABASE_URL and migrate the real database.
    expect(execFileSyncMock.mock.calls[0][2]).toMatchObject({
      env: expect.objectContaining({ DATABASE_URL: SAFE }),
    });
  });
});

describe('createTestPrismaClient', () => {
  it('refuses to construct a client for an unsafe database', () => {
    vi.stubEnv('TEST_DATABASE_URL', DEVELOPMENT);

    expect(() => createTestPrismaClient()).toThrow(/not marked disposable/);
  });
});

describe('truncateAll', () => {
  it('refuses to truncate when the configuration is unsafe', async () => {
    vi.stubEnv('TEST_DATABASE_URL', DEVELOPMENT);
    const prisma = { $executeRawUnsafe: vi.fn() } as unknown as PrismaClient;

    await expect(truncateAll(prisma)).rejects.toThrow(/not marked disposable/);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
