import type { ExecResult, GitCheckoutResult } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';
import type { ErrorResponse } from './test-worker/types';

/**
 * Git Clone Workflow Tests
 *
 * Tests git clone operations including:
 * - Shallow clone with depth option
 * - Error handling for nonexistent/private repositories
 *
 * Happy path tests for full clones are in comprehensive-workflow.test.ts.
 */
describe('Git Clone Error Handling', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers(createUniqueSession());
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
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

  test('should reject invalid git clone timeout values before cloning', async () => {
    const cloneResponse = await fetch(`${workerUrl}/api/git/clone`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        repoUrl: 'https://github.com/octocat/Spoon-Knife',
        cloneTimeoutMs: 0
      })
    });

    expect(cloneResponse.status).toBeGreaterThanOrEqual(400);
    const errorData = (await cloneResponse.json()) as ErrorResponse;
    // "Invalid timeout value" comes from the HTTP handler's validation;
    // "Invalid clone timeout" comes from the git service itself.
    expect(errorData.error).toMatch(
      /Invalid (timeout value|clone timeout).*0/i
    );
  });
});

/**
 * Git Shallow Clone Tests
 *
 * Tests the depth option for shallow clones.
 * Uses octocat/Spoon-Knife for real-remote coverage with faster clone times.
 *
 * These tests depend on GitHub availability and are retried to handle
 * transient network degradation (see #484).
 */
describe('Git Shallow Clone', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers(createUniqueSession());
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test(
    'should clone repository with depth: 1 (shallow clone)',
    { retry: 2, timeout: 150000 },
    async () => {
      const testDir = sandbox!.uniquePath('shallow-clone-1');

      // Clone with depth: 1 against a real remote repository
      const cloneResponse = await fetch(`${workerUrl}/api/git/clone`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          repoUrl: 'https://github.com/octocat/Spoon-Knife',
          targetDir: testDir,
          depth: 1
        })
      });

      expect(cloneResponse.status).toBe(200);
      const cloneData = (await cloneResponse.json()) as GitCheckoutResult;
      expect(cloneData.success).toBe(true);

      // Verify shallow clone by counting commits
      // A shallow clone with depth: 1 should have exactly 1 commit
      const countResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `cd ${testDir} && git rev-list --count HEAD`
        })
      });

      expect(countResponse.status).toBe(200);
      const countData = (await countResponse.json()) as ExecResult;
      expect(countData.exitCode).toBe(0);

      const commitCount = parseInt(countData.stdout.trim(), 10);
      expect(commitCount).toBe(1);

      // Also verify the repo is marked as shallow
      const shallowResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `cd ${testDir} && git rev-parse --is-shallow-repository`
        })
      });

      expect(shallowResponse.status).toBe(200);
      const shallowData = (await shallowResponse.json()) as ExecResult;
      expect(shallowData.exitCode).toBe(0);
      expect(shallowData.stdout.trim()).toBe('true');
    }
  );

  test(
    'should clone repository with branch and depth combined',
    { retry: 2, timeout: 150000 },
    async () => {
      const testDir = sandbox!.uniquePath('shallow-branch');

      // Clone specific branch with depth: 1
      const cloneResponse = await fetch(`${workerUrl}/api/git/clone`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          repoUrl: 'https://github.com/octocat/Spoon-Knife',
          branch: 'main',
          targetDir: testDir,
          depth: 1
        })
      });

      expect(cloneResponse.status).toBe(200);
      const cloneData = (await cloneResponse.json()) as GitCheckoutResult;
      expect(cloneData.success).toBe(true);

      // Verify shallow clone
      const shallowResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `cd ${testDir} && git rev-parse --is-shallow-repository`
        })
      });

      expect(shallowResponse.status).toBe(200);
      const shallowData = (await shallowResponse.json()) as ExecResult;
      expect(shallowData.stdout.trim()).toBe('true');

      // Verify we're on the correct branch
      const branchResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `cd ${testDir} && git branch --show-current`
        })
      });

      expect(branchResponse.status).toBe(200);
      const branchData = (await branchResponse.json()) as ExecResult;
      expect(branchData.stdout.trim()).toBe('main');

      // Verify commit count is 1
      const countResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `cd ${testDir} && git rev-list --count HEAD`
        })
      });

      expect(countResponse.status).toBe(200);
      const countData = (await countResponse.json()) as ExecResult;
      expect(parseInt(countData.stdout.trim(), 10)).toBe(1);
    }
  );
});
