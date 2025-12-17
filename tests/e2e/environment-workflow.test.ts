import type { ExecEvent, ExecResult } from '@repo/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import { parseSSEStream } from '../../packages/sandbox/src/sse-parser';
import {
  createUniqueSession,
  getSharedSandbox
} from './helpers/global-sandbox';

/**
 * Environment Variable Tests
 *
 * Tests all ways to set environment variables and their override behavior:
 * - Dockerfile ENV (base level, e.g. SANDBOX_VERSION)
 * - setEnvVars at session level
 * - Per-command env in exec()
 * - Per-command env in execStream()
 *
 * Override precedence (highest to lowest):
 * 1. Per-command env
 * 2. Session-level setEnvVars
 * 3. Dockerfile ENV
 */
describe('Environment Variables', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
  }, 120000);

  test('should have Dockerfile ENV vars available', async () => {
    // SANDBOX_VERSION is set in the Dockerfile
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo $SANDBOX_VERSION' })
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as ExecResult;
    expect(data.success).toBe(true);
    // Should have some version value (not empty)
    expect(data.stdout.trim()).toBeTruthy();
    expect(data.stdout.trim()).not.toBe('$SANDBOX_VERSION');
  }, 30000);

  test('should set and persist session-level env vars via setEnvVars', async () => {
    // Set env vars at session level
    const setResponse = await fetch(`${workerUrl}/api/env/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        envVars: {
          MY_SESSION_VAR: 'session-value',
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
        command: 'echo "$MY_SESSION_VAR:$ANOTHER_VAR"'
      })
    });

    expect(readResponse.status).toBe(200);
    const readData = (await readResponse.json()) as ExecResult;
    expect(readData.stdout.trim()).toBe('session-value:another-value');
  }, 30000);

  test('should support per-command env in exec()', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "$CMD_VAR"',
        env: { CMD_VAR: 'command-specific-value' }
      })
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as ExecResult;
    expect(data.stdout.trim()).toBe('command-specific-value');
  }, 30000);

  test('should support per-command env in execStream()', async () => {
    const response = await fetch(`${workerUrl}/api/execStream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "$STREAM_VAR"',
        env: { STREAM_VAR: 'stream-env-value' }
      })
    });

    expect(response.status).toBe(200);

    // Collect streamed output
    const events: ExecEvent[] = [];
    const abortController = new AbortController();
    for await (const event of parseSSEStream<ExecEvent>(
      response.body!,
      abortController.signal
    )) {
      events.push(event);
      if (event.type === 'complete' || event.type === 'error') break;
    }

    const stdout = events
      .filter((e) => e.type === 'stdout')
      .map((e) => e.data)
      .join('');
    expect(stdout.trim()).toBe('stream-env-value');
  }, 30000);

  test('should override session env with per-command env', async () => {
    // First set a session-level var
    await fetch(`${workerUrl}/api/env/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        envVars: { OVERRIDE_TEST: 'session-level' }
      })
    });

    // Verify session value
    const sessionResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo "$OVERRIDE_TEST"' })
    });
    const sessionData = (await sessionResponse.json()) as ExecResult;
    expect(sessionData.stdout.trim()).toBe('session-level');

    // Override with per-command env
    const overrideResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "$OVERRIDE_TEST"',
        env: { OVERRIDE_TEST: 'command-level' }
      })
    });
    const overrideData = (await overrideResponse.json()) as ExecResult;
    expect(overrideData.stdout.trim()).toBe('command-level');

    // Session value should still be intact
    const afterResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo "$OVERRIDE_TEST"' })
    });
    const afterData = (await afterResponse.json()) as ExecResult;
    expect(afterData.stdout.trim()).toBe('session-level');
  }, 30000);

  test('should override Dockerfile ENV with session setEnvVars', async () => {
    // Create a fresh session to test clean override
    const sandbox = await getSharedSandbox();
    const freshHeaders = sandbox.createHeaders(createUniqueSession());

    // First read Dockerfile value
    const beforeResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: freshHeaders,
      body: JSON.stringify({ command: 'echo "$SANDBOX_VERSION"' })
    });
    const beforeData = (await beforeResponse.json()) as ExecResult;
    const dockerValue = beforeData.stdout.trim();
    expect(dockerValue).toBeTruthy();

    // Override with session setEnvVars
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
      body: JSON.stringify({ command: 'echo "$SANDBOX_VERSION"' })
    });
    const afterData = (await afterResponse.json()) as ExecResult;
    expect(afterData.stdout.trim()).toBe('overridden-version');
  }, 30000);

  test('should handle commands that read stdin without hanging', async () => {
    // Test 1: cat with no arguments should exit immediately with EOF
    const catResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'cat'
      })
    });

    expect(catResponse.status).toBe(200);
    const catData = (await catResponse.json()) as ExecResult;
    expect(catData.success).toBe(true);
    expect(catData.stdout).toBe('');

    // Test 2: bash read command should return immediately
    const readResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'read -t 1 INPUT_VAR || echo "read returned"'
      })
    });

    expect(readResponse.status).toBe(200);
    const readData = (await readResponse.json()) as ExecResult;
    expect(readData.success).toBe(true);
    expect(readData.stdout).toContain('read returned');

    // Test 3: grep with no file should exit immediately
    const grepResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'grep "test" || true'
      })
    });

    expect(grepResponse.status).toBe(200);
    const grepData = (await grepResponse.json()) as ExecResult;
    expect(grepData.success).toBe(true);
  }, 90000);
});
