import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi
} from 'vitest';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import {
  createSandboxId,
  createTestHeaders,
  fetchWithStartup,
  cleanupSandbox
} from './helpers/test-fixtures';

describe('Issue #144: Exec with per-command env vars (REPRODUCTION)', () => {
  describe('local', () => {
    let runner: WranglerDevRunner | null;
    let workerUrl: string;
    let currentSandboxId: string | null = null;

    beforeAll(async () => {
      const result = await getTestWorkerUrl();
      workerUrl = result.url;
      runner = result.runner;
    });

    afterEach(async () => {
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

    test('should pass env vars to individual exec command via options.env', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Execute command with env vars passed via options
      // BUG: These env vars are currently IGNORED
      const execResponse = await vi.waitFor(
        async () =>
          fetchWithStartup(`${workerUrl}/api/execute`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              command: 'echo $EXEC_VAR',
              env: { EXEC_VAR: 'from_exec_options' }
            })
          }),
        { timeout: 90000, interval: 2000 }
      );

      expect(execResponse.status).toBe(200);
      const execData = await execResponse.json();
      expect(execData.success).toBe(true);

      // This assertion will FAIL with current implementation
      // because env vars are not passed through
      expect(execData.stdout.trim()).toBe('from_exec_options');
    }, 90000);

    test('should pass cwd to individual exec command via options.cwd', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Create a test directory
      await vi.waitFor(
        async () =>
          fetchWithStartup(`${workerUrl}/api/file/mkdir`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              path: '/workspace/testdir',
              recursive: true
            })
          }),
        { timeout: 90000, interval: 2000 }
      );

      // Execute command with cwd passed via options
      // BUG: The cwd option is currently IGNORED
      const execResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'pwd',
          cwd: '/workspace/testdir'
        })
      });

      expect(execResponse.status).toBe(200);
      const execData = await execResponse.json();
      expect(execData.success).toBe(true);

      // This assertion will FAIL with current implementation
      // because cwd is not passed through
      expect(execData.stdout.trim()).toBe('/workspace/testdir');
    }, 90000);

    test('should use per-command env vars without affecting session env', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Set a session-level env var
      await vi.waitFor(
        async () =>
          fetchWithStartup(`${workerUrl}/api/env/set`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              envVars: { SESSION_VAR: 'session_value' }
            })
          }),
        { timeout: 90000, interval: 2000 }
      );

      // Execute command with per-command env var
      // BUG: The per-command env var is currently IGNORED
      const execResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'echo "SESSION=$SESSION_VAR CMD=$CMD_VAR"',
          env: { CMD_VAR: 'cmd_value' }
        })
      });

      expect(execResponse.status).toBe(200);
      const execData = await execResponse.json();
      expect(execData.success).toBe(true);

      // Should see both session var and command-specific var
      // This assertion will FAIL because CMD_VAR is not set
      expect(execData.stdout.trim()).toBe(
        'SESSION=session_value CMD=cmd_value'
      );

      // Verify session var persists but command var does not
      const verifyResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'echo "SESSION=$SESSION_VAR CMD=$CMD_VAR"'
        })
      });

      expect(verifyResponse.status).toBe(200);
      const verifyData = await verifyResponse.json();
      expect(verifyData.success).toBe(true);

      // Session var should still be set, command var should be empty
      expect(verifyData.stdout.trim()).toBe('SESSION=session_value CMD=');
    }, 90000);

    test('should allow multiple env vars in single exec command', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Execute command with multiple env vars
      // BUG: All env vars are currently IGNORED
      const execResponse = await vi.waitFor(
        async () =>
          fetchWithStartup(`${workerUrl}/api/execute`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              command: 'echo "A=$VAR_A B=$VAR_B C=$VAR_C"',
              env: {
                VAR_A: 'value_a',
                VAR_B: 'value_b',
                VAR_C: 'value_c'
              }
            })
          }),
        { timeout: 90000, interval: 2000 }
      );

      expect(execResponse.status).toBe(200);
      const execData = await execResponse.json();
      expect(execData.success).toBe(true);

      // This assertion will FAIL because env vars are not passed
      expect(execData.stdout.trim()).toBe('A=value_a B=value_b C=value_c');
    }, 90000);
  });
});
