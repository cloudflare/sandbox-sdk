import { describe, test, expect, beforeAll } from 'vitest';
import {
  getSharedSandbox,
  createUniqueSession
} from './helpers/global-sandbox';
import type { ExecResult, WriteFileResult, ReadFileResult } from '@repo/shared';
import type { ErrorResponse } from './test-worker/types';

/**
 * Build and Test Workflow Integration Tests
 *
 * Tests the README "Build and Test Code" example.
 * Uses the shared sandbox with a unique session.
 */
describe('Build and Test Workflow', () => {
  describe('local', () => {
    let workerUrl: string;
    let headers: Record<string, string>;

    beforeAll(async () => {
      const sandbox = await getSharedSandbox();
      workerUrl = sandbox.workerUrl;
      headers = sandbox.createHeaders(createUniqueSession());
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

      // Should return 500 error since shell terminated unexpectedly
      expect(response.status).toBe(500);
      const data = (await response.json()) as ErrorResponse;

      // Should have an error object (500 responses may not have success field)
      expect(data.error).toBeDefined();
      expect(data.error).toMatch(/shell terminated unexpectedly/i);
      expect(data.error).toMatch(/exit code.*1/i);
    });
  });
});
