/**
 * Standalone Binary Workflow Test
 *
 * Tests the standalone binary pattern where users copy the /sandbox binary
 * into an arbitrary Docker image (node:20-slim in this case).
 *
 * Key behaviors validated:
 * - Binary works on non-Ubuntu base images
 * - CMD passthrough executes user-defined startup scripts
 * - Server continues running after CMD exits
 */

import type { ExecResult, ReadFileResult } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';

describe('Standalone Binary Workflow', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox({
      type: 'standalone',
      initCommand: 'until [ -f /tmp/startup-marker.txt ]; do sleep 0.1; done'
    });
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers(createUniqueSession());
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('binary works on arbitrary base image', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo "ok"' })
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as ExecResult;
    expect(result.exitCode).toBe(0);
  });

  test('CMD passthrough executes startup script', async () => {
    // startup-test.sh writes a marker file; its existence proves CMD ran
    const response = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: '/tmp/startup-marker.txt' })
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as ReadFileResult;
    expect(result.content).toMatch(/^startup-\d+$/);
  });
});
