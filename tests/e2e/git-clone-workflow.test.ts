import { beforeAll, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox,
  uniqueTestPath
} from './helpers/global-sandbox';
import type { ErrorResponse } from './test-worker/types';

/**
 * Git Clone Error Handling Tests
 *
 * Tests error cases for git clone operations.
 * Happy path tests are in comprehensive-workflow.test.ts.
 *
 * This file focuses on:
 * - Nonexistent repository handling
 * - Private repository without auth
 */

// Transport modes to test
const transportModes = [
  { name: 'HTTP', useWebSocket: false },
  { name: 'WebSocket', useWebSocket: true }
];

describe.each(transportModes)(
  'Git Clone Error Handling ($name transport)',
  ({ useWebSocket }) => {
    let workerUrl: string;
    let headers: Record<string, string>;

    beforeAll(async () => {
      const sandbox = await getSharedSandbox();
      workerUrl = sandbox.workerUrl;
      const baseHeaders = sandbox.createHeaders(createUniqueSession());
      headers = useWebSocket
        ? { ...baseHeaders, 'X-Use-WebSocket': 'true' }
        : baseHeaders;
    }, 120000);

    test('should handle git clone errors for nonexistent repository', async () => {
      const cloneResponse = await fetch(`${workerUrl}/api/git/clone`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          repoUrl:
            'https://github.com/nonexistent/repository-that-does-not-exist-12345'
        })
      });

      expect(cloneResponse.status).toBe(500);
      const errorData = (await cloneResponse.json()) as ErrorResponse;
      expect(errorData.error).toBeTruthy();
      expect(errorData.error).toMatch(
        /not found|does not exist|repository|fatal/i
      );
    }, 90000);

    test('should handle git clone errors for private repository without auth', async () => {
      const cloneResponse = await fetch(`${workerUrl}/api/git/clone`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          repoUrl:
            'https://github.com/cloudflare/private-test-repo-that-requires-auth'
        })
      });

      expect(cloneResponse.status).toBe(500);
      const errorData = (await cloneResponse.json()) as ErrorResponse;
      expect(errorData.error).toBeTruthy();
      expect(errorData.error).toMatch(
        /authentication|permission|access|denied|fatal|not found/i
      );
    }, 90000);
  }
);
