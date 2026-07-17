import type { ReadFileResult, WriteFileResult } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { CommandResponse } from './command-response';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

/**
 * Build and Test Workflow Integration Tests
 *
 * Tests the README "Build and Test Code" example.
 * Uses an isolated sandbox for deterministic workspace state.
 */
describe('Build and Test Workflow', () => {
  describe('local', () => {
    let sandbox: TestSandbox | null = null;
    let workerUrl: string;
    let headers: Record<string, string>;

    beforeAll(async () => {
      sandbox = await createTestSandbox();
      workerUrl = sandbox.workerUrl;
      headers = sandbox.headers();
    }, 120000);

    test('should execute basic commands and verify file operations', async () => {
      // Step 1: Execute simple command
      const echoResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: ['/bin/bash', '-lc', 'echo "Hello from sandbox"']
        })
      });

      expect(echoResponse.status).toBe(200);
      const echoData = (await echoResponse.json()) as CommandResponse;
      expect(echoData.exitCode).toBe(0);
      expect(echoData.stdout).toContain('Hello from sandbox');

      // Step 2: Write a file (using absolute path per README pattern)
      const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/test-file.txt',
          content: 'Integration test content'
        })
      });

      expect(writeResponse.status).toBe(200);
      const writeData = (await writeResponse.json()) as WriteFileResult;
      expect(writeData.success).toBe(true);

      // Step 3: Read the file back to verify persistence
      const readResponse = await fetch(`${workerUrl}/api/file/read`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/test-file.txt'
        })
      });

      expect(readResponse.status).toBe(200);
      const readData = (await readResponse.json()) as ReadFileResult;
      expect(readData.content).toBe('Integration test content');

      // Step 4: Verify pwd to understand working directory
      const pwdResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: ['/bin/bash', '-lc', 'pwd']
        })
      });

      expect(pwdResponse.status).toBe(200);
      const pwdData = (await pwdResponse.json()) as CommandResponse;
      expect(pwdData.stdout).toMatch(/\/workspace/);
    });

    test('should report non-zero exit commands as exec output', async () => {
      const response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: ['/bin/bash', '-lc', 'exit 1']
        })
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as CommandResponse;

      expect(data.success).toBe(false);
      expect(data.exitCode).toBe(1);
      expect(data.stdout).toBe('');
    });

    afterAll(async () => {
      await cleanupTestSandbox(sandbox);
      sandbox = null;
    }, 120000);
  });
});
