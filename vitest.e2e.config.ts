import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Load environment variables from .env file
config();

/**
 * E2E test configuration
 *
 * These tests run against deployed Cloudflare Workers (in CI) or local wrangler dev.
 * They validate true end-to-end behavior with real Durable Objects and containers.
 *
 * Run with: npm run test:e2e
 *
 * Architecture:
 * - CI: Uses TEST_WORKER_URL pointing to deployed worker
 * - Local: Each test file spawns its own wrangler dev instance
 * - Tests run SEQUENTIALLY to avoid container provisioning resource contention
 */

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

    // Run tests sequentially to avoid infrastructure resource contention
    // Parallel execution causes container provisioning issues on both local and CI
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true // Force sequential execution
      }
    },
    fileParallelism: false // No parallel file execution
  }
});
