import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import { createSandboxId, createTestHeaders, fetchWithStartup, cleanupSandbox } from './helpers/test-fixtures';

describe('Environment Variables Workflow', () => {
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
      if (runner) {
        await runner.stop();
      }
    });

    test('should set a single environment variable and verify it', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Step 1: Set environment variable
      const setEnvResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/env/set`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            envVars: { TEST_VAR: 'hello_world' },
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      expect(setEnvResponse.status).toBe(200);
      const setEnvData = await setEnvResponse.json();
      expect(setEnvData.success).toBe(true);

      // Step 2: Verify environment variable with echo command (same sandbox)
      const execResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'echo $TEST_VAR',
        }),
      });

      expect(execResponse.status).toBe(200);
      const execData = await execResponse.json();
      expect(execData.success).toBe(true);
      expect(execData.stdout.trim()).toBe('hello_world');
    }, 90000);

    test('should set multiple environment variables at once', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Step 1: Set multiple environment variables
      const setEnvResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/env/set`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            envVars: {
              API_KEY: 'secret123',
              DB_HOST: 'localhost',
              PORT: '3000',
            },
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      expect(setEnvResponse.status).toBe(200);
      const setEnvData = await setEnvResponse.json();
      expect(setEnvData.success).toBe(true);

      // Step 2: Verify all environment variables (same sandbox)
      const execResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'echo "$API_KEY|$DB_HOST|$PORT"',
        }),
      });

      expect(execResponse.status).toBe(200);
      const execData = await execResponse.json();
      expect(execData.success).toBe(true);
      expect(execData.stdout.trim()).toBe('secret123|localhost|3000');
    }, 90000);

    test('should persist environment variables across multiple commands', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Step 1: Set environment variable
      const setEnvResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/env/set`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            envVars: { PERSISTENT_VAR: 'still_here' },
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      expect(setEnvResponse.status).toBe(200);

      // Step 2: Run first command to verify env var (same sandbox)
      const exec1Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'echo $PERSISTENT_VAR',
        }),
      });

      expect(exec1Response.status).toBe(200);
      const exec1Data = await exec1Response.json();
      expect(exec1Data.success).toBe(true);
      expect(exec1Data.stdout.trim()).toBe('still_here');

      // Step 3: Run different command - env var should still be available (same sandbox)
      const exec2Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'printenv PERSISTENT_VAR',
        }),
      });

      expect(exec2Response.status).toBe(200);
      const exec2Data = await exec2Response.json();
      expect(exec2Data.success).toBe(true);
      expect(exec2Data.stdout.trim()).toBe('still_here');

      // Step 4: Run third command with different shell builtin (same sandbox)
      const exec3Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'sh -c "echo $PERSISTENT_VAR"',
        }),
      });

      expect(exec3Response.status).toBe(200);
      const exec3Data = await exec3Response.json();
      expect(exec3Data.success).toBe(true);
      expect(exec3Data.stdout.trim()).toBe('still_here');
    }, 90000);

    test('should make environment variables available to background processes', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Step 1: Set environment variable
      const setEnvResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/env/set`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            envVars: { PROCESS_VAR: 'from_env' },
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      expect(setEnvResponse.status).toBe(200);

      // Step 2: Start a background process that uses the environment variable (same sandbox)
      // Write a simple script that outputs the env var and exits
      const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/env-test.sh',
          content: '#!/bin/sh\necho "ENV_VALUE=$PROCESS_VAR"\n',
        }),
      });

      expect(writeResponse.status).toBe(200);

      // Make script executable (same sandbox)
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'chmod +x /workspace/env-test.sh',
        }),
      });

      // Step 3: Start the process (same sandbox)
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: '/workspace/env-test.sh',
        }),
      });

      expect(startResponse.status).toBe(200);
      const startData = await startResponse.json();
      expect(startData.id).toBeTruthy();
      const processId = startData.id;

      // Step 4: Wait for process to complete and get logs (same sandbox)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const logsResponse = await fetch(
        `${workerUrl}/api/process/${processId}/logs`,
        {
          method: 'GET',
          headers,
        }
      );

      expect(logsResponse.status).toBe(200);
      const logsData = await logsResponse.json();
      expect(logsData.stdout).toContain('ENV_VALUE=from_env');

      // Cleanup (same sandbox)
      await fetch(`${workerUrl}/api/file/delete`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({
          path: '/workspace/env-test.sh',
        }),
      });
    }, 90000);

    test('should handle commands that read stdin without hanging', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Test 1: cat with no arguments should exit immediately with EOF
      const catResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'cat',
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      expect(catResponse.status).toBe(200);
      const catData = await catResponse.json();
      // cat with no input should exit with code 0 and produce no output
      expect(catData.success).toBe(true);
      expect(catData.stdout).toBe('');

      // Test 2: bash read command should return immediately
      const readResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'read -t 1 INPUT_VAR || echo "read returned"',
        }),
      });

      expect(readResponse.status).toBe(200);
      const readData = await readResponse.json();
      expect(readData.success).toBe(true);
      expect(readData.stdout).toContain('read returned');

      // Test 3: grep with no file should exit immediately
      const grepResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'grep "test" || true',
        }),
      });

      expect(grepResponse.status).toBe(200);
      const grepData = await grepResponse.json();
      expect(grepData.success).toBe(true);
    }, 90000);
  });
});
