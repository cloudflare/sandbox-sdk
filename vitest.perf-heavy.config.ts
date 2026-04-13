import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config();

/**
 * Heavy performance tests (bucket mounting, backup/restore).
 * Runs in a separate vitest process from core perf tests to avoid
 * resource contention that inflates measurements.
 */
export default defineConfig({
  test: {
    name: 'perf-heavy',
    globals: true,
    environment: 'node',
    include: ['tests/perf/heavy/**/*.test.ts'],

    // Extra-long timeouts for large data operations (10GB backups, etc.)
    testTimeout: 1800000, // 30 minutes per test
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
      json: './perf-results/vitest-heavy-output.json'
    }
  }
});
