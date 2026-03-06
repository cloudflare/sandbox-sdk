import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';
import type { HealthResponse } from './test-worker/types';

/**
 * Smoke test to verify integration test infrastructure
 *
 * This test validates that:
 * 1. Can get worker URL (deployed in CI, wrangler dev locally)
 * 2. Worker is running and responding
 * 3. Isolated sandbox initializes correctly
 */
describe('Integration Infrastructure Smoke Test', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;

  beforeAll(async () => {
    // Create isolated sandbox for this test file
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('should verify worker is running with health check', async () => {
    // Verify worker is running with health check
    const response = await fetch(`${workerUrl}/health`);
    expect(response.status).toBe(200);

    const data = (await response.json()) as HealthResponse;
    expect(data.status).toBe('ok');
  });
});
