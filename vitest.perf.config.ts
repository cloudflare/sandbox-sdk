import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config();

/**
 * Performance tests - runs scenarios sequentially to avoid interference.
 * Each scenario manages its own concurrency internally.
 * No retries - we want accurate failure data for baselines.
 */
export default defineConfig({
  test: {
    name: 'perf',
    globals: true,
    environment: 'node',
    include: ['tests/perf/scenarios/**/*.test.ts'],

    // Propagate env vars to worker threads (they don't inherit process.env reliably)
    env: {
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
      R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? '',
      TEST_WORKER_URL: process.env.TEST_WORKER_URL ?? ''
    },

    // Longer timeouts for performance tests
    testTimeout: 600000, // 10 minutes per test
    hookTimeout: 120000, // 2 minutes for setup/teardown
    teardownTimeout: 60000,

    // Global setup/teardown for report generation
    globalSetup: ['tests/perf/global-setup.ts'],

    // Run tests sequentially to avoid interference between scenarios
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
        isolate: true
      }
    },
    fileParallelism: false,

    // No retries for perf tests - we want accurate data
    retry: 0,

    // Reporter configuration
    reporters: ['default', 'json'],
    outputFile: {
      json: './perf-results/vitest-output.json'
    }
  }
});
