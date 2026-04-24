import type { ExecResult, ReadFileResult, WriteFileResult } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';
import type { ErrorResponse } from './test-worker/types';

/**
 * Build and Test Workflow Integration Tests
 *
 * Tests the README "Build and Test Code" example.
 * Uses an isolated sandbox with a unique session.
 */
describe('Build and Test Workflow', () => {
  describe('local', () => {
    let sandbox: TestSandbox | null = null;
    let workerUrl: string;
    let headers: Record<string, string>;

    beforeAll(async () => {
      sandbox = await createTestSandbox();
      workerUrl = sandbox.workerUrl;
      headers = sandbox.headers(createUniqueSession());
    }, 120000);

    test('should execute basic commands and verify file operations', async () => {
      // Step 1: Execute simple command
      const echoResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'echo "Hello from sandbox"'
        })
      });

      expect(echoResponse.status).toBe(200);
      const echoData = (await echoResponse.json()) as ExecResult;
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
          command: 'pwd'
        })
      });

      expect(pwdResponse.status).toBe(200);
      const pwdData = (await pwdResponse.json()) as ExecResult;
      expect(pwdData.stdout).toMatch(/\/workspace/);
    });

    test('should detect shell termination when exit command is used', async () => {
      // Execute 'exit 1' which will terminate the shell itself
      // This should now be detected and reported as a shell termination error
      const response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'exit 1'
        })
      });

      // Shell exit should surface as 410 SESSION_TERMINATED per the
      // SESSION_TERMINATED contract (see .changeset/session-terminated.md).
      expect(response.status).toBe(410);
      const data = (await response.json()) as ErrorResponse & {
        code?: string;
      };

      expect(data.error).toBeDefined();
      expect(data.code).toBe('SESSION_TERMINATED');
      expect(data.error).toMatch(/shell exited/i);
      expect(data.error).toMatch(/exit code:?\s*1/i);
    });

    afterAll(async () => {
      await cleanupTestSandbox(sandbox);
      sandbox = null;
    }, 120000);
  });
});
