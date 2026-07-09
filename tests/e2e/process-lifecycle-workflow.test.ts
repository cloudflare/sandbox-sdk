import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { CommandResponse } from './command-response';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

// Dedicated port for this test file's port exposure error tests
const PORT_LIFECYCLE_TEST_PORT = 9998;
const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

describe('Process Lifecycle Integration Tests', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;
  let portHeaders: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();
    // Port exposure requires sandbox headers
    portHeaders = {
      'X-Sandbox-Id': sandbox.sandboxId,
      'Content-Type': 'application/json'
    };
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('should kill a running exec handle', async () => {
    const response = await fetch(`${workerUrl}/api/kill-running-exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: ['/bin/bash', '-lc', 'sleep 30'] })
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { exitCode: number };
    expect(result.exitCode).not.toBe(0);
  }, 90000);

  test.skipIf(skipPortExposureTests)(
    'should reject exposing reserved ports',
    async () => {
      const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
        method: 'POST',
        headers: portHeaders,
        body: JSON.stringify({
          port: 22,
          name: 'ssh-server'
        })
      });

      expect(exposeResponse.status).toBeGreaterThanOrEqual(400);
      const errorData = (await exposeResponse.json()) as { error: string };
      expect(errorData.error).toBeTruthy();
      expect(errorData.error).toMatch(
        /reserved|not allowed|forbidden|invalid port/i
      );
    },
    90000
  );

  test.skipIf(skipPortExposureTests)(
    'should treat unexposing a non-exposed port as idempotent revocation',
    async () => {
      const unexposeResponse = await fetch(
        `${workerUrl}/api/exposed-ports/${PORT_LIFECYCLE_TEST_PORT}`,
        {
          method: 'DELETE',
          headers: portHeaders
        }
      );

      expect(unexposeResponse.status).toBe(200);
      await expect(unexposeResponse.json()).resolves.toMatchObject({
        success: true,
        port: PORT_LIFECYCLE_TEST_PORT
      });
    },
    90000
  );
});
