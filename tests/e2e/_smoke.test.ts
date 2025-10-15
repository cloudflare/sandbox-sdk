import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import { createSandboxId, cleanupSandbox } from './helpers/test-fixtures';

/**
 * Smoke test to verify integration test infrastructure
 *
 * This test validates that:
 * 1. Can get worker URL (deployed in CI, wrangler dev locally)
 * 2. Worker is running and responding
 * 3. Can cleanup properly
 *
 * NOTE: This is just infrastructure validation. Real SDK integration
 * tests will be in the workflow test suites.
 */
describe('Integration Infrastructure Smoke Test', () => {
  describe('local', () => {
    let runner: WranglerDevRunner | null = null;
    let workerUrl: string;
    let currentSandboxId: string | null = null;

    beforeAll(async () => {
      const result = await getTestWorkerUrl();
      workerUrl = result.url;
      runner = result.runner;
    });

    afterEach(async () => {
      // Cleanup sandbox container after each test
      if (currentSandboxId) {
        await cleanupSandbox(workerUrl, currentSandboxId);
        currentSandboxId = null;
      }
    });

    afterAll(async () => {
      if (runner) {
        await runner.stop();
      }
    });

    test('should verify worker is running with health check', async () => {
      // Verify worker is running with health check
      const response = await fetch(`${workerUrl}/health`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('ok');

      // In local mode, verify stdout captured wrangler startup
      if (runner) {
        const stdout = runner.getStdout();
        expect(stdout).toContain('Ready on');
      }
    });
  });
});
