import { defineConfig } from 'vitest/config';

/**
 * E2E test configuration
 *
 * These tests run against deployed Cloudflare Workers (in CI) or local wrangler dev.
 * They validate true end-to-end behavior with real Durable Objects and containers.
 *
 * Run with: npm run test:e2e
 *
 * Parallelization strategy:
 * - Local: Serial execution (wrangler dev can be unstable with parallel tests)
 * - CI: Parallel execution (deployed worker handles concurrency well)
 */

// Check if running in CI environment
const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

export default defineConfig({
  test: {
    name: 'e2e',
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],

    // Longer timeouts for E2E tests (wrangler startup, container operations)
    testTimeout: 120000, // 2 minutes per test
    hookTimeout: 60000, // 1 minute for beforeAll/afterAll
    teardownTimeout: 30000, // 30s for cleanup

    // Conditional parallelization based on environment
    pool: 'forks',
    ...(isCI ? {
      // CI: Enable parallel execution - deployed worker handles it well
      poolOptions: {
        forks: {
          singleFork: false,
        },
      },
      fileParallelism: true,
    } : {
      // Local: Serial execution to avoid wrangler dev conflicts
      maxConcurrency: 1,
      poolOptions: {
        forks: {
          singleFork: true,
        },
      },
    }),
  },
});
