import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'container-tests',
    globals: true,
    include: ['container_src/__tests__/**/*.test.ts', '__tests__/integration/**/*.test.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
    teardownTimeout: 10000,
    isolate: true,
    pool: 'forks', // Use forks for container tests
    poolOptions: {
      forks: {
        singleFork: false, // Use separate forks for better test isolation
      },
    },
    environment: 'node',
    setupFiles: ['container_src/__tests__/setup.ts'],
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
      '@container': path.resolve(__dirname, 'container_src'),
    },
  },
});