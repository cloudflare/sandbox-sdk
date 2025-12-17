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
describe('Git Clone Error Handling', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
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
});
