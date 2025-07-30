import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'contract-tests',
    globals: true,
    include: ['src/__tests__/contracts/**/*.test.ts'],
    testTimeout: 15000, // Longer timeout for real container interactions
    hookTimeout: 10000,
    teardownTimeout: 10000,
    isolate: true,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    environment: 'node',
    setupFiles: ['src/__tests__/contracts/setup.ts'],
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
      '@container': path.resolve(__dirname, 'container_src'),
    },
  },
});