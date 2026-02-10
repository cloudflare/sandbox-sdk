/**
 * Standalone Alpine Binary Workflow Test
 *
 * Tests the standalone musl binary pattern where users copy the /sandbox-musl
 * binary into an Alpine Docker image.
 *
 * Key behaviors validated:
 * - Musl binary works on Alpine (musl libc) base images
 * - CMD passthrough executes user-defined startup scripts
 * - Server continues running after CMD exits
 */

import type { ExecResult, ReadFileResult } from '@repo/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox
} from './helpers/global-sandbox';

describe('Standalone Alpine Binary Workflow', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createStandaloneAlpineHeaders(createUniqueSession());
  }, 120000);

  test('musl binary works on Alpine base image', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo "ok"' })
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as ExecResult;
    expect(result.exitCode).toBe(0);
  });

  test('CMD passthrough executes startup script on Alpine', async () => {
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
