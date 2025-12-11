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

import { describe, test, expect, beforeAll } from 'vitest';
import {
  getSharedSandbox,
  createUniqueSession
} from './helpers/global-sandbox';
import type { ExecResult, ReadFileResult } from '@repo/shared';

describe('Standalone Binary Workflow', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createStandaloneHeaders(createUniqueSession());
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
