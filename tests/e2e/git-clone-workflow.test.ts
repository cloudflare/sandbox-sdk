import type { ExecResult, GitCheckoutResult } from '@repo/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox,
  uniqueTestPath
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

/**
 * Git Shallow Clone Tests
 *
 * Tests the depth option for shallow clones.
 * Uses facebook/react which has extensive history to properly test shallow cloning.
 */
describe('Git Shallow Clone', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
  }, 120000);

  test('should clone repository with depth: 1 (shallow clone)', async () => {
    const testDir = uniqueTestPath('shallow-clone-1');

    // Clone with depth: 1 - use a repo with extensive history
    const cloneResponse = await fetch(`${workerUrl}/api/git/clone`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        repoUrl: 'https://github.com/facebook/react',
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
  }, 120000);

  test('should clone repository with depth: 5 (limited history)', async () => {
    const testDir = uniqueTestPath('shallow-clone-5');

    // Clone with depth: 5 - use a repo with extensive history
    const cloneResponse = await fetch(`${workerUrl}/api/git/clone`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        repoUrl: 'https://github.com/facebook/react',
        targetDir: testDir,
        depth: 5
      })
    });

    expect(cloneResponse.status).toBe(200);
    const cloneData = (await cloneResponse.json()) as GitCheckoutResult;
    expect(cloneData.success).toBe(true);

    // Verify commit count is exactly 5
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
    expect(commitCount).toBe(5);

    // Verify the repo is marked as shallow
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
  }, 120000);

  test('should clone repository with branch and depth combined', async () => {
    const testDir = uniqueTestPath('shallow-branch');

    // Clone specific branch with depth: 1
    const cloneResponse = await fetch(`${workerUrl}/api/git/clone`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        repoUrl: 'https://github.com/facebook/react',
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
  }, 120000);
});
