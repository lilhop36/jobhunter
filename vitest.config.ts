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
