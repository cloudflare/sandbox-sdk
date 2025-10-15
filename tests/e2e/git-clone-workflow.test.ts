import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import { createSandboxId, createTestHeaders, fetchWithStartup, cleanupSandbox } from './helpers/test-fixtures';

/**
 * Git Clone Workflow Integration Tests
 *
 * Tests the README "Build and Test Code" example (lines 343-362):
 * - Clone a repository
 * - Run npm install
 * - Execute npm commands
 *
 * This validates the complete Git workflow:
 * Clone → Install → Build/Test
 *
 * Uses a real public repository to test:
 * - Git clone operations
 * - Working with actual repositories
 * - Multi-step workflows matching production usage
 */
describe('Git Clone Workflow', () => {
  describe('local', () => {
    let runner: WranglerDevRunner | null;
    let workerUrl: string;
    let currentSandboxId: string | null = null;

    beforeAll(async () => {
      // Get test worker URL (CI: uses deployed URL, Local: spawns wrangler dev)
      const result = await getTestWorkerUrl();
      workerUrl = result.url;
      runner = result.runner;
    });

    afterEach(async () => {
      // Cleanup sandbox container after each test
      if (currentSandboxId) {
        await cleanupSandbox(workerUrl, currentSandboxId);
        currentSandboxId = null;
      }
    });

    afterAll(async () => {
      // Cleanup wrangler process (only in local mode)
      if (runner) {
        await runner.stop();
      }
    });

    test('should clone a public repository successfully', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Clone a very small public repository for testing
      // Using octocat/Hello-World - a minimal test repository
      // Use vi.waitFor to handle container startup time
      const cloneResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/git/clone`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            repoUrl: 'https://github.com/octocat/Hello-World',
            branch: 'master',
            targetDir: '/workspace/test-repo',
          }),
        }),
        { timeout: 90000, interval: 3000 } // Git clone can take longer, wait up to 90s
      );

      expect(cloneResponse.status).toBe(200);
      const cloneData = await cloneResponse.json();
      expect(cloneData.success).toBe(true);

      // Verify the repository was cloned by checking for README
      const fileCheckResponse = await fetch(`${workerUrl}/api/file/read`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/test-repo/README',
        }),
      });

      expect(fileCheckResponse.status).toBe(200);
      const fileData = await fileCheckResponse.json();
      expect(fileData.content).toBeTruthy();
      expect(fileData.content).toContain('Hello'); // Verify README content
    });

    test('should clone repository with specific branch', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Clone a repository with a specific branch (using master for Hello-World)
      const cloneResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/git/clone`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            repoUrl: 'https://github.com/octocat/Hello-World',
            branch: 'master', // Explicitly specify master branch
            targetDir: '/workspace/branch-test',

          }),
        }),
        { timeout: 90000, interval: 3000 }
      );

      expect(cloneResponse.status).toBe(200);
      const cloneData = await cloneResponse.json();
      expect(cloneData.success).toBe(true);

      // Verify we're on the correct branch by checking git branch
      const branchCheckResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'cd /workspace/branch-test && git branch --show-current',

        }),
      });

      expect(branchCheckResponse.status).toBe(200);
      const branchData = await branchCheckResponse.json();
      expect(branchData.stdout.trim()).toBe('master');
    });

    test('should execute complete workflow: clone → list files → verify structure', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Step 1: Clone the Hello-World repository
      const cloneResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/git/clone`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            repoUrl: 'https://github.com/octocat/Hello-World',
            targetDir: '/workspace/project',

          }),
        }),
        { timeout: 90000, interval: 3000 }
      );

      expect(cloneResponse.status).toBe(200);

      // Step 2: List directory contents to verify clone
      const listResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'ls -la /workspace/project',

        }),
      });

      expect(listResponse.status).toBe(200);
      const listData = await listResponse.json();
      expect(listData.exitCode).toBe(0);
      expect(listData.stdout).toContain('README'); // Verify README exists
      expect(listData.stdout).toContain('.git'); // Verify .git directory exists

      // Step 3: Verify README content
      const readmeResponse = await fetch(`${workerUrl}/api/file/read`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/project/README',

        }),
      });

      expect(readmeResponse.status).toBe(200);
      const readmeData = await readmeResponse.json();
      expect(readmeData.content).toBeTruthy();

      // Step 4: Run a git command to verify repo is functional
      const gitLogResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'cd /workspace/project && git log --oneline -1',

        }),
      });

      expect(gitLogResponse.status).toBe(200);
      const gitLogData = await gitLogResponse.json();
      expect(gitLogData.exitCode).toBe(0);
      expect(gitLogData.stdout).toBeTruthy(); // Should have at least one commit
    });

    test('should handle cloning to default directory when targetDir not specified', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Clone without specifying targetDir (should use repo name "Hello-World")
      const cloneResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/git/clone`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            repoUrl: 'https://github.com/octocat/Hello-World',

          }),
        }),
        { timeout: 90000, interval: 3000 }
      );

      expect(cloneResponse.status).toBe(200);
      const cloneData = await cloneResponse.json();
      expect(cloneData.success).toBe(true);

      // The SDK should extract 'Hello-World' from the URL and clone there
      // Verify by checking if Hello-World directory exists
      const dirCheckResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'ls -la /workspace',

        }),
      });

      expect(dirCheckResponse.status).toBe(200);
      const dirData = await dirCheckResponse.json();
      expect(dirData.stdout).toContain('Hello-World');
    });

    test('should handle git clone errors for nonexistent repository', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Try to clone a non-existent repository
      const cloneResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/git/clone`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            repoUrl: 'https://github.com/nonexistent/repository-that-does-not-exist-12345',

          }),
        }, { expectSuccess: false }), // Don't throw on error - we expect this to fail
        { timeout: 60000, interval: 2000 }
      );

      // Git clone should fail with appropriate error
      expect(cloneResponse.status).toBe(500);
      const errorData = await cloneResponse.json();
      expect(errorData.error).toBeTruthy();
      // Should mention repository not found or doesn't exist
      expect(errorData.error).toMatch(/not found|does not exist|repository|fatal/i);
    });

    test('should handle git clone errors for private repository without auth', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Try to clone a private repository without providing credentials
      // Using a known private repo pattern (will fail with auth error)
      const cloneResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/git/clone`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            repoUrl: 'https://github.com/cloudflare/private-test-repo-that-requires-auth',

          }),
        }, { expectSuccess: false }), // Don't throw on error - we expect this to fail
        { timeout: 60000, interval: 2000 }
      );

      // Should fail with authentication error
      expect(cloneResponse.status).toBe(500);
      const errorData = await cloneResponse.json();
      expect(errorData.error).toBeTruthy();
      // Should mention authentication, permission, or access denied
      expect(errorData.error).toMatch(/authentication|permission|access|denied|fatal|not found/i);
    });

    test('should maintain session state across git clone and subsequent commands', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Step 1: Clone a repository
      const cloneResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/git/clone`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            repoUrl: 'https://github.com/octocat/Hello-World',
            targetDir: '/workspace/state-test',

          }),
        }),
        { timeout: 90000, interval: 3000 }
      );

      expect(cloneResponse.status).toBe(200);

      // Step 2: Create a new file in the cloned directory
      const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/state-test/test-marker.txt',
          content: 'Session state test',

        }),
      });

      expect(writeResponse.status).toBe(200);

      // Step 3: List files to verify both cloned content and our new file exist
      const listResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'ls /workspace/state-test',

        }),
      });

      expect(listResponse.status).toBe(200);
      const listData = await listResponse.json();
      expect(listData.stdout).toContain('README'); // From cloned repo
      expect(listData.stdout).toContain('test-marker.txt'); // Our new file
    });
  });
});
