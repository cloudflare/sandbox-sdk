import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config();

/**
 * E2E tests using SHARED SANDBOX - can run in parallel
 * These tests use unique sessions for isolation within one container.
 */

// Only exclude bucket-mounting (requires special R2 setup)
const isolatedTests = ['tests/e2e/bucket-mounting.test.ts'];

export default defineConfig({
  test: {
    name: 'e2e-shared',
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: isolatedTests,

    testTimeout: 120000,
    hookTimeout: 60000,
    teardownTimeout: 30000,

    // Global setup creates sandbox BEFORE threads spawn, passes info through a tmp file
    globalSetup: ['tests/e2e/global-setup.ts'],

    // Now threads can run in parallel - they all use the same sandbox through a tmp file
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        isolate: false
      }
    },

    retry: 1
  }
});
