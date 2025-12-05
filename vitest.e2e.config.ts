import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config();

/**
 * E2E tests using shared sandbox - runs in parallel
 * Tests use unique sessions for isolation within one container.
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

    // Global setup creates sandbox BEFORE threads spawn, passes info through a tmp file
    globalSetup: ['tests/e2e/global-setup.ts'],

    // Threads run in parallel - they all use the same sandbox through a tmp file
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        isolate: false
      }
    },
    fileParallelism: true,

    retry: 1
  }
});
