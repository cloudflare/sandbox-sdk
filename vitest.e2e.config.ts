import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

config();

if (!process.env.TEST_TRANSPORT) {
  try {
    // Temporary workaround so existing CI still works with new format. The generate_config script will
    // write this file instead of setting the SANDBOX_TRANSPORT var in the worker config.
    process.env.TEST_TRANSPORT = readFileSync(
      join(__dirname, './tests/e2e/test-worker/TEST_TRANSPORT'),
      'utf-8'
    ).trim();
  } catch (err) {
    throw new Error('Missing TEST_TRANSPORT environment variable');
  }
}

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
