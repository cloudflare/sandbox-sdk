import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { CommandResponse } from './command-response';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

/**
 * Environment Variable Tests
 *
 * Tests all ways to set environment variables and their override behavior:
 * - Dockerfile ENV (base level, e.g. SANDBOX_VERSION)
 * - setEnvVars for sandbox environment state
 * - Per-command env in exec()
 *
 * Override precedence (highest to lowest):
 * 1. Per-command env
 * 2. Sandbox-level setEnvVars
 * 3. Dockerfile ENV
 */
describe('Environment Variables', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('should have Dockerfile ENV vars available', async () => {
    // SANDBOX_VERSION is set in the Dockerfile
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'echo $SANDBOX_VERSION']
      })
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as CommandResponse;
    expect(data.success).toBe(true);
    // Should have some version value (not empty)
    expect(data.stdout.trim()).toBeTruthy();
    expect(data.stdout.trim()).not.toBe('$SANDBOX_VERSION');
  }, 30000);

  test('should set and persist sandbox env vars via setEnvVars', async () => {
    // Set env vars for the sandbox
    const setResponse = await fetch(`${workerUrl}/api/env/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        envVars: {
          MY_CONTEXT_VAR: 'context-value',
          ANOTHER_VAR: 'another-value'
        }
      })
    });

    expect(setResponse.status).toBe(200);

    // Verify they persist across commands
    const readResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'echo "$MY_CONTEXT_VAR:$ANOTHER_VAR"']
      })
    });

    expect(readResponse.status).toBe(200);
    const readData = (await readResponse.json()) as CommandResponse;
    expect(readData.stdout.trim()).toBe('context-value:another-value');
  }, 30000);

  test('should support per-command env in exec()', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'echo "$CMD_VAR"'],
        env: { CMD_VAR: 'command-specific-value' }
      })
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as CommandResponse;
    expect(data.stdout.trim()).toBe('command-specific-value');
  }, 30000);

  test('should override sandbox env with per-command env', async () => {
    // First set a sandbox-level var
    await fetch(`${workerUrl}/api/env/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        envVars: { OVERRIDE_TEST: 'sandbox-level' }
      })
    });

    // Verify sandbox-level value
    const sandboxResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'echo "$OVERRIDE_TEST"']
      })
    });
    const sandboxData = (await sandboxResponse.json()) as CommandResponse;
    expect(sandboxData.stdout.trim()).toBe('sandbox-level');

    // Override with per-command env
    const overrideResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'echo "$OVERRIDE_TEST"'],
        env: { OVERRIDE_TEST: 'command-level' }
      })
    });
    const overrideData = (await overrideResponse.json()) as CommandResponse;
    expect(overrideData.stdout.trim()).toBe('command-level');

    // Sandbox-level value should still be intact
    const afterResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'echo "$OVERRIDE_TEST"']
      })
    });
    const afterData = (await afterResponse.json()) as CommandResponse;
    expect(afterData.stdout.trim()).toBe('sandbox-level');
  }, 30000);

  test('should override Dockerfile ENV with setEnvVars', async () => {
    const freshHeaders = sandbox!.headers();

    // First read Dockerfile value
    const beforeResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: freshHeaders,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'echo "$SANDBOX_VERSION"']
      })
    });
    const beforeData = (await beforeResponse.json()) as CommandResponse;
    const dockerValue = beforeData.stdout.trim();
    expect(dockerValue).toBeTruthy();

    // Override with setEnvVars
    await fetch(`${workerUrl}/api/env/set`, {
      method: 'POST',
      headers: freshHeaders,
      body: JSON.stringify({
        envVars: { SANDBOX_VERSION: 'overridden-version' }
      })
    });

    // Verify override
    const afterResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: freshHeaders,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'echo "$SANDBOX_VERSION"']
      })
    });
    const afterData = (await afterResponse.json()) as CommandResponse;
    expect(afterData.stdout.trim()).toBe('overridden-version');
  }, 30000);

  test('should handle commands that read stdin without hanging', async () => {
    // Test 1: cat with no arguments should exit immediately with EOF
    const catResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'cat']
      })
    });

    expect(catResponse.status).toBe(200);
    const catData = (await catResponse.json()) as CommandResponse;
    expect(catData.success).toBe(true);
    expect(catData.stdout).toBe('');

    // Test 2: bash read command should return immediately
    const readResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: [
          '/bin/bash',
          '-lc',
          'read -t 1 INPUT_VAR || echo "read returned"'
        ]
      })
    });

    expect(readResponse.status).toBe(200);
    const readData = (await readResponse.json()) as CommandResponse;
    expect(readData.success).toBe(true);
    expect(readData.stdout).toContain('read returned');

    // Test 3: grep with no file should exit immediately
    const grepResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'grep "test" || true']
      })
    });

    expect(grepResponse.status).toBe(200);
    const grepData = (await grepResponse.json()) as CommandResponse;
    expect(grepData.success).toBe(true);
  }, 90000);

  test('should handle null as unset in setEnvVars', async () => {
    const setResponse = await fetch(`${workerUrl}/api/env/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        envVars: {
          UNSET_DEFINED: 'test-value',
          UNSET_NULL: null,
          UNSET_EMPTY: ''
        }
      })
    });

    expect(setResponse.status).toBe(200);

    const definedResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'echo $UNSET_DEFINED']
      })
    });
    expect(definedResponse.status).toBe(200);
    const definedData = (await definedResponse.json()) as CommandResponse;
    expect(definedData.stdout.trim()).toBe('test-value');

    const nullResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'printenv UNSET_NULL || echo "not set"']
      })
    });
    expect(nullResponse.status).toBe(200);
    const nullData = (await nullResponse.json()) as CommandResponse;
    expect(nullData.stdout.trim()).toBe('not set');

    const emptyResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'echo "[$UNSET_EMPTY]"']
      })
    });
    expect(emptyResponse.status).toBe(200);
    const emptyData = (await emptyResponse.json()) as CommandResponse;
    expect(emptyData.stdout.trim()).toBe('[]');
  }, 30000);

  test('should unset previously set env var when passed null', async () => {
    const setResponse = await fetch(`${workerUrl}/api/env/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ envVars: { TO_REMOVE: 'initial-value' } })
    });
    expect(setResponse.status).toBe(200);

    const beforeResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: ['/bin/bash', '-lc', 'echo $TO_REMOVE'] })
    });
    expect(beforeResponse.status).toBe(200);
    const beforeData = (await beforeResponse.json()) as CommandResponse;
    expect(beforeData.stdout.trim()).toBe('initial-value');

    const unsetResponse = await fetch(`${workerUrl}/api/env/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ envVars: { TO_REMOVE: null } })
    });
    expect(unsetResponse.status).toBe(200);

    const afterResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'printenv TO_REMOVE || echo "not set"']
      })
    });
    expect(afterResponse.status).toBe(200);
    const afterData = (await afterResponse.json()) as CommandResponse;
    expect(afterData.stdout.trim()).toBe('not set');
  }, 30000);

  test('should filter null env vars in per-command execution', async () => {
    const validResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'echo $CMD_VALID'],
        env: { CMD_VALID: 'valid-value', CMD_INVALID: null }
      })
    });
    expect(validResponse.status).toBe(200);
    const validData = (await validResponse.json()) as CommandResponse;
    expect(validData.stdout.trim()).toBe('valid-value');

    const invalidResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'printenv CMD_INVALID || echo "not set"'],
        env: { CMD_VALID: 'valid-value', CMD_INVALID: null }
      })
    });
    expect(invalidResponse.status).toBe(200);
    const invalidData = (await invalidResponse.json()) as CommandResponse;
    expect(invalidData.stdout.trim()).toBe('not set');
  }, 30000);
});
