import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Integration tests share one PostgreSQL database and truncate between
    // cases. Running files in parallel would let one file TRUNCATE another's
    // fixtures mid-test, so files must be strictly sequential.
    fileParallelism: false,
    // Every database file opens with `applyTestMigrations()`, which shells out to
    // `prisma migrate deploy`. That subprocess took over the 10 s hook default when the
    // suite ran alongside the live worker, failing two files on a hook alone while all
    // their tests passed. A slow-but-finite setup is not a defect, so the bound is raised
    // for hooks only - a test that overruns its own budget still fails.
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      '@domain': path.resolve('src/domain'),
      '@application': path.resolve('src/application'),
      '@ports': path.resolve('src/ports'),
      '@adapters': path.resolve('src/adapters'),
      '@infrastructure': path.resolve('src/infrastructure'),
      '@app': path.resolve('apps'),
    },
  },
});
