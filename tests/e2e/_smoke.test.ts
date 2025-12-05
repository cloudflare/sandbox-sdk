import { describe, test, expect, beforeAll } from 'vitest';
import { getSharedSandbox } from './helpers/global-sandbox';
import type { HealthResponse } from './test-worker/types';

/**
 * Smoke test to verify integration test infrastructure
 *
 * This test validates that:
 * 1. Can get worker URL (deployed in CI, wrangler dev locally)
 * 2. Worker is running and responding
 * 3. Shared sandbox initializes correctly
 *
 * NOTE: This test runs first (sorted by name) and initializes the shared sandbox.
 */
describe('Integration Infrastructure Smoke Test', () => {
  let workerUrl: string;

  beforeAll(async () => {
    // Initialize shared sandbox - this will be reused by all other tests
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
  }, 120000);

  test('should verify worker is running with health check', async () => {
    // Verify worker is running with health check
    const response = await fetch(`${workerUrl}/health`);
    expect(response.status).toBe(200);

    const data = (await response.json()) as HealthResponse;
    expect(data.status).toBe('ok');
  });
});
