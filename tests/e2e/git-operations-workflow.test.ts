import type {
  ExecResult,
  GitBranchListResult,
  GitOperationResult,
  GitStatusResult
} from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';

interface E2EErrorResponse {
  error: string;
  code?: string;
}

describe('Git Operations Workflow', () => {
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

  const setupGitRepo = async (repoPath: string, commands: string[]) => {
    const setupResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: [
          `mkdir -p ${repoPath}`,
          `cd ${repoPath}`,
          'git init',
          "git config user.name 'E2E Test'",
          "git config user.email 'e2e@example.com'",
          ...commands
        ].join(' && ')
      })
    });

    expect(setupResponse.status).toBe(200);
    const setupData = (await setupResponse.json()) as ExecResult;
    expect(setupData.exitCode).toBe(0);
  };

  test('should create and checkout a branch through git endpoints', async () => {
    const repoPath = sandbox!.uniquePath('git-ops-branch');

    await setupGitRepo(repoPath, [
      "echo 'hello' > README.md",
      'git add README.md',
      "git commit -m 'initial commit'",
      'git branch -M main'
    ]);

    const createBranchResponse = await fetch(
      `${workerUrl}/api/git/create-branch`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          repoPath,
          branch: 'feature/e2e'
        })
      }
    );

    expect(createBranchResponse.status).toBe(200);
    const createBranchData =
      (await createBranchResponse.json()) as GitOperationResult;
    expect(createBranchData.success).toBe(true);

    const checkoutResponse = await fetch(
      `${workerUrl}/api/git/checkout-branch`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          repoPath,
          branch: 'main'
        })
      }
    );

    expect(checkoutResponse.status).toBe(200);

    const branchesResponse = await fetch(`${workerUrl}/api/git/branches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ repoPath })
    });

    expect(branchesResponse.status).toBe(200);
    const branchesData = (await branchesResponse.json()) as GitBranchListResult;
    expect(branchesData.success).toBe(true);
    expect(branchesData.currentBranch).toBe('main');
    expect(branchesData.branches).toContain('main');
    expect(branchesData.branches).toContain('feature/e2e');
  }, 120000);

  test('should stage, commit, and report clean status', async () => {
    const repoPath = sandbox!.uniquePath('git-ops-commit');

    await setupGitRepo(repoPath, [
      "echo 'base' > README.md",
      'git add README.md',
      "git commit -m 'initial commit'",
      "echo 'updated' >> README.md"
    ]);

    const addResponse = await fetch(`${workerUrl}/api/git/add`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        repoPath,
        files: ['README.md']
      })
    });

    expect(addResponse.status).toBe(200);
    const addData = (await addResponse.json()) as GitOperationResult;
    expect(addData.success).toBe(true);

    const commitResponse = await fetch(`${workerUrl}/api/git/commit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        repoPath,
        message: 'update readme'
      })
    });

    expect(commitResponse.status).toBe(200);
    const commitData = (await commitResponse.json()) as GitOperationResult;
    expect(commitData.success).toBe(true);

    const statusResponse = await fetch(`${workerUrl}/api/git/status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ repoPath })
    });

    expect(statusResponse.status).toBe(200);
    const statusData = (await statusResponse.json()) as GitStatusResult;
    expect(statusData.success).toBe(true);
    expect(statusData.fileStatus).toHaveLength(0);
  }, 120000);

  test('should return structured validation error for invalid branch name', async () => {
    const repoPath = sandbox!.uniquePath('git-ops-validation');

    await setupGitRepo(repoPath, [
      "echo 'base' > README.md",
      'git add README.md',
      "git commit -m 'initial commit'"
    ]);

    const response = await fetch(`${workerUrl}/api/git/create-branch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        repoPath,
        branch: '   '
      })
    });

    expect(response.status).toBe(400);
    const errorData = (await response.json()) as E2EErrorResponse;
    expect(errorData.error).toContain('Invalid branch name');
    expect(errorData.code).toBe('VALIDATION_FAILED');
  }, 120000);
});
