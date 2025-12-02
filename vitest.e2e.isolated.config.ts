import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config();

/**
 * E2E tests requiring SPECIAL SETUP (R2 buckets, etc.)
 * Only bucket-mounting tests need this - everything else uses shared sandbox.
 */

export default defineConfig({
  test: {
    name: 'e2e-isolated',
    globals: true,
    environment: 'node',
    include: ['tests/e2e/bucket-mounting.test.ts'],

    testTimeout: 120000,
    hookTimeout: 60000,
    teardownTimeout: 30000,

    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
        isolate: false
      }
    },

    retry: 1
  }
});
