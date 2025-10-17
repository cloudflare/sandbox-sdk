import { defineConfig } from 'vitest/config';

/**
 * E2E test configuration
 *
 * These tests run against deployed Cloudflare Workers (in CI) or local wrangler dev.
 * They validate true end-to-end behavior with real Durable Objects and containers.
 *
 * Run with: npm run test:e2e
 *
 * Architecture:
 * - Global setup starts ONE wrangler dev before all tests
 * - All test files share this instance via TEST_WORKER_URL_GLOBAL_SETUP env var
 * - Tests can run in parallel because they share the worker but use isolated sandboxes
 * - Global setup returns teardown function that stops wrangler after all tests complete
 */

// Check if running in CI environment
const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

export default defineConfig({
  test: {
    name: 'e2e',
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],

    // Global setup for shared wrangler dev instance
    // Returns teardown function to stop wrangler after all tests
    globalSetup: ['./tests/e2e/global-setup.ts'],

    // Longer timeouts for E2E tests (wrangler startup, container operations)
    testTimeout: 120000, // 2 minutes per test
    hookTimeout: 60000, // 1 minute for beforeAll/afterAll
    teardownTimeout: 30000, // 30s for cleanup

    // Enable parallel execution for both local and CI
    // Safe because global setup ensures only ONE wrangler dev runs
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    fileParallelism: true,
  },
});
