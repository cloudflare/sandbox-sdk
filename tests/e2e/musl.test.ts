/**
 * Musl Image Variant Test
 *
 * Tests the Alpine-based musl image variant (cloudflare/sandbox:VERSION-musl).
 * This image is a functional sandbox with musl-linked binary on Alpine Linux.
 *
 * Key behaviors validated:
 * - Musl binary starts and serves requests on Alpine
 * - Basic exec works (shell commands via musl libc)
 * - File operations work on Alpine filesystem
 */

import type { ExecResult, ReadFileResult } from '@repo/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox
} from './helpers/global-sandbox';

describe('Musl Image Variant', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createMuslHeaders(createUniqueSession());
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

  test('file operations work on Alpine', async () => {
    const testContent = 'musl-test-content';
    const testPath = '/workspace/musl-test.txt';

    const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testPath, content: testContent })
    });
    expect(writeResponse.status).toBe(200);

    const readResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testPath })
    });
    expect(readResponse.status).toBe(200);
    const result = (await readResponse.json()) as ReadFileResult;
    expect(result.content).toBe(testContent);
  });
});
