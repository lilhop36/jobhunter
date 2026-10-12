import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@domain': path.resolve(__dirname, 'src/domain'),
      '@application': path.resolve(__dirname, 'src/application'),
      '@ports': path.resolve(__dirname, 'src/ports'),
      '@adapters': path.resolve(__dirname, 'src/adapters'),
      '@infrastructure': path.resolve(__dirname, 'src/infrastructure'),
      '@app': path.resolve(__dirname, 'apps'),
    },
  },
});
