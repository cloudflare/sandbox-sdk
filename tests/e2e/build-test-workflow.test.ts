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
        }),
        signal: AbortSignal.timeout(5000)
      });

      expect(echoResponse.status).toBe(200);
      await expect(echoResponse.json()).resolves.toEqual(
        expect.objectContaining({
          exitCode: 0,
          stdout: expect.stringContaining('Hello from sandbox')
        })
      );

      // Step 2: Write a file (using absolute path per README pattern)
      const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/test-file.txt',
          content: 'Integration test content'
        }),
        signal: AbortSignal.timeout(5000)
      });

      expect(writeResponse.status).toBe(200);
      await expect(writeResponse.json()).resolves.toEqual(
        expect.objectContaining({ success: true })
      );

      // Step 3: Read the file back to verify persistence
      const readResponse = await fetch(`${workerUrl}/api/file/read`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/test-file.txt'
        }),
        signal: AbortSignal.timeout(5000)
      });

      expect(readResponse.status).toBe(200);
      await expect(readResponse.json()).resolves.toEqual(
        expect.objectContaining({ content: 'Integration test content' })
      );

      // Step 4: Verify pwd to understand working directory
      const pwdResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'pwd'
        }),
        signal: AbortSignal.timeout(5000)
      });

      expect(pwdResponse.status).toBe(200);
      await expect(pwdResponse.json()).resolves.toEqual(
        expect.objectContaining({
          stdout: expect.stringMatching(/\/workspace/)
        })
      );
    });

    test('should detect shell termination when exit command is used', async () => {
      // Execute 'exit 1' which will terminate the shell itself
      // This should now be detected and reported as a shell termination error
      const response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'exit 1'
        }),
        signal: AbortSignal.timeout(5000)
      });

      // Should return 500 error since shell terminated unexpectedly
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          error: expect.stringMatching(/shell terminated unexpectedly/i)
        })
      );
    });

    afterAll(async () => {
      await cleanupTestSandbox(sandbox);
      sandbox = null;
    }, 120000);
  });
});
