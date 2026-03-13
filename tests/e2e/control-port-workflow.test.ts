import { DEFAULT_CONTROL_PORT } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';

const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

describe('Control Port Configuration', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;
  let portHeaders: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers(createUniqueSession());
    portHeaders = {
      'X-Sandbox-Id': sandbox.sandboxId,
      'Content-Type': 'application/json'
    };
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('container should bind to the default control port', async () => {
    // Convert port to hex for /proc/net/tcp lookup (always available, no ss/netstat needed)
    const portHex = DEFAULT_CONTROL_PORT.toString(16)
      .toUpperCase()
      .padStart(4, '0');
    const result = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `grep ':${portHex}' /proc/net/tcp`
      })
    });

    expect(result.status).toBe(200);
    const data = (await result.json()) as { stdout: string; exitCode: number };
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toContain(portHex);
  }, 90000);

  test('port 3000 should not be reserved by the control plane', async () => {
    const result = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command:
          "node -e \"const s = require('net').createServer(); s.listen(3000, () => { console.log('bound'); s.close(); })\""
      })
    });

    expect(result.status).toBe(200);
    const data = (await result.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toContain('bound');
  }, 90000);

  test.skipIf(skipPortExposureTests)(
    'should reject exposing the control port',
    async () => {
      const response = await fetch(`${workerUrl}/api/port/expose`, {
        method: 'POST',
        headers: portHeaders,
        body: JSON.stringify({
          port: DEFAULT_CONTROL_PORT,
          name: 'control-plane'
        })
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toMatch(
        /reserved|not allowed|forbidden|invalid port/i
      );
    },
    90000
  );

  test.skipIf(skipPortExposureTests)(
    'should allow exposing port 3000 as a user service',
    async () => {
      const response = await fetch(`${workerUrl}/api/port/expose`, {
        method: 'POST',
        headers: portHeaders,
        body: JSON.stringify({
          port: 3000,
          name: 'user-app'
        })
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { port: number };
      expect(data.port).toBe(3000);
    },
    90000
  );
});
