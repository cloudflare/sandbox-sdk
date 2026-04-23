import assert from 'node:assert';
import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config();

if (!process.env.TEST_TRANSPORT) {
  try {
    // Attempt to extract the transport from the worker URL for backwards
    const workerURL = new URL(process.env.TEST_WORKER_URL ?? '');
    const transportRegexp =
      /sandbox-e2e-test-worker-(?:.+)-(?<transport>http|websocket).(?:[^.]+)[.]workers[.]dev/;
    process.env.TEST_TRANSPORT = transportRegexp.exec(
      workerURL.host
    )?.groups?.transport;
    assert(['http', 'websocket'].includes(process.env.TEST_TRANSPORT ?? ''));
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
