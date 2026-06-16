import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config();

/**
 * E2E tests with per-file sandbox isolation - runs in parallel.
 * Each test file creates its own sandbox via createTestSandbox().
 * Bucket-mounting tests self-skip locally (require FUSE/CI).
 */
export default defineConfig({
  test: {
    name: 'e2e',
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],

    testTimeout: 120000,
    hookTimeout: 60000,
    teardownTimeout: 30000,

    // Global setup resolves worker URL, passes it through a tmp file
    globalSetup: ['tests/e2e/global-setup.ts'],

    // Threads run in parallel - each file creates its own sandbox
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        isolate: false
      }
    },
    fileParallelism: true
  }
});
