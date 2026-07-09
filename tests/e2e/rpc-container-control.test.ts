/**
 * RPC Container Control E2E Tests
 *
 * Validates core sandbox operations work end-to-end through the
 * container-control path. These tests exercise:
 * - Command execution (exec)
 * - Process log streaming
 * - File operations (write, read, list, delete)
 *
 */

import type { ListFilesResult, ReadFileResult } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { CommandResponse } from './command-response';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

describe('RPC Container Control', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('should execute a command and return stdout', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: ['/bin/bash', '-lc', 'echo hello-rpc'] })
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as CommandResponse;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello-rpc');
  });

  test('should handle command with non-zero exit code', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: ['/bin/bash', '-lc', 'sh -c "exit 42"'] })
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as CommandResponse;
    expect(result.exitCode).toBe(42);
  });

  test('should write and read a file', async () => {
    const testPath = sandbox!.uniquePath('rpc-test.txt');
    const testContent = 'Hello from RPC control! 🚀';

    // Write
    const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testPath, content: testContent })
    });
    expect(writeResponse.status).toBe(200);

    // Read
    const readResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testPath })
    });
    expect(readResponse.status).toBe(200);
    const readResult = (await readResponse.json()) as ReadFileResult;
    expect(readResult.content).toBe(testContent);
  });

  test('should list files in a directory', async () => {
    const testDir = sandbox!.uniquePath('rpc-list');

    // Create directory with files
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: [
          '/bin/bash',
          '-lc',
          `mkdir -p ${testDir} && touch ${testDir}/a.txt ${testDir}/b.txt`
        ]
      })
    });

    const response = await fetch(`${workerUrl}/api/list-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testDir })
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as ListFilesResult;
    expect(result.files.length).toBeGreaterThanOrEqual(2);
    const names = result.files.map((f) => f.name);
    expect(names).toContain('a.txt');
    expect(names).toContain('b.txt');
  });

  test('should delete a file', async () => {
    const testPath = sandbox!.uniquePath('rpc-delete.txt');

    // Create file
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: testPath,
        content: 'to be deleted'
      })
    });

    // Delete
    const deleteResponse = await fetch(`${workerUrl}/api/file/delete`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ path: testPath })
    });
    expect(deleteResponse.status).toBe(200);

    // Verify gone
    const existsResponse = await fetch(`${workerUrl}/api/file/exists`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testPath })
    });
    expect(existsResponse.status).toBe(200);
    const existsResult = (await existsResponse.json()) as {
      exists: boolean;
    };
    expect(existsResult.exists).toBe(false);
  });
});
