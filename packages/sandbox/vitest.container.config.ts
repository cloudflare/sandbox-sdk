import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    name: 'container-tests',
    globals: true,
    include: ['src/__tests__/container/**/*.test.ts', 'src/__tests__/container-integration/**/*.test.ts'],
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
    setupFiles: ['src/__tests__/container/setup.ts'],
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
      '@container': path.resolve(__dirname, 'container_src'),
    },
  },
});