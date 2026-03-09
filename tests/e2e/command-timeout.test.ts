import type {
  ExecResult,
  SessionCreateResult,
  SessionDeleteResult
} from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';
import { createTestHeaders } from './helpers/test-fixtures';
import type { ErrorResponse } from './test-worker/types';

/**
 * Command Timeout Tests
 */
describe('Command Timeout', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let sandboxId: string;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    sandboxId = sandbox.sandboxId;
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('sandbox.exec should respect per-command timeout', async () => {
    const sessionId = createUniqueSession();

    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId, sessionId),
      body: JSON.stringify({
        command: 'sleep 30',
        timeout: 1000
      })
    });

    expect(response.status).toBe(500);
    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
    expect(data.error).toMatch(/timeout/i);
  }, 30000);

  test('session.exec should respect per-command timeout', async () => {
    // Create a session without a session-level timeout
    const createResponse = await fetch(`${workerUrl}/api/session/create`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId),
      body: JSON.stringify({})
    });

    expect(createResponse.status).toBe(200);
    const createData = (await createResponse.json()) as SessionCreateResult;
    const sessionId = createData.sessionId;

    // Execute a long-running command with a short per-command timeout
    const execResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId, sessionId),
      body: JSON.stringify({
        command: 'sleep 30',
        timeout: 1000
      })
    });

    expect(execResponse.status).toBe(500);
    const execData = (await execResponse.json()) as ErrorResponse;
    expect(execData.error).toBeDefined();
    expect(execData.error).toMatch(/timeout/i);
  }, 30000);

  test('session.exec should respect session-level commandTimeoutMs', async () => {
    // Create a session WITH a session-level timeout
    const createResponse = await fetch(`${workerUrl}/api/session/create`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId),
      body: JSON.stringify({
        commandTimeoutMs: 1000
      })
    });

    expect(createResponse.status).toBe(200);
    const createData = (await createResponse.json()) as SessionCreateResult;
    const sessionId = createData.sessionId;

    // Execute a long-running command WITHOUT per-command timeout
    // The session-level timeout should apply
    const execResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId, sessionId),
      body: JSON.stringify({
        command: 'sleep 30'
      })
    });

    expect(execResponse.status).toBe(500);
    const execData = (await execResponse.json()) as ErrorResponse;
    expect(execData.error).toBeDefined();
    expect(execData.error).toMatch(/timeout/i);
  }, 30000);

  test('per-command timeout should take precedence over session-level commandTimeoutMs', async () => {
    // Create a session with a LONG session-level timeout (30s)
    const createResponse = await fetch(`${workerUrl}/api/session/create`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId),
      body: JSON.stringify({
        commandTimeoutMs: 30000
      })
    });

    expect(createResponse.status).toBe(200);
    const createData = (await createResponse.json()) as SessionCreateResult;
    const sessionId = createData.sessionId;

    // Execute with a SHORT per-command timeout (1s)
    // The per-command timeout should win over the 30s session timeout
    const startTime = Date.now();

    const execResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId, sessionId),
      body: JSON.stringify({
        command: 'sleep 30',
        timeout: 1000
      })
    });

    const elapsed = Date.now() - startTime;

    expect(execResponse.status).toBe(500);
    const execData = (await execResponse.json()) as ErrorResponse;
    expect(execData.error).toMatch(/timeout/i);

    // Should have timed out in ~1s, not ~30s
    expect(elapsed).toBeLessThan(10000);
  }, 30000);

  test('timed-out command continues running; session can be deleted while command runs', async () => {
    // Create a session
    const createResponse = await fetch(`${workerUrl}/api/session/create`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId),
      body: JSON.stringify({})
    });

    expect(createResponse.status).toBe(200);
    const createData = (await createResponse.json()) as SessionCreateResult;
    const sessionId = createData.sessionId;

    // Start a long-running command with a marker file, using a short timeout.
    // The command writes a file, sleeps, then writes another file.
    // After timeout, the first file should exist (command started),
    // and we should be able to delete the session.
    const execResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId, sessionId),
      body: JSON.stringify({
        command:
          'touch /tmp/timeout-test-started && sleep 120 && touch /tmp/timeout-test-finished',
        timeout: 1000
      })
    });

    expect(execResponse.status).toBe(500);
    const execData = (await execResponse.json()) as ErrorResponse;
    expect(execData.error).toMatch(/timeout/i);

    // Verify the command did start (marker file exists)
    const checkStarted = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId),
      body: JSON.stringify({
        command: 'test -f /tmp/timeout-test-started && echo "exists"'
      })
    });

    expect(checkStarted.status).toBe(200);
    const checkData = (await checkStarted.json()) as ExecResult;
    expect(checkData.stdout.trim()).toBe('exists');

    // Delete the session while the command is still sleeping in background
    const deleteResponse = await fetch(`${workerUrl}/api/session/delete`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId),
      body: JSON.stringify({ sessionId })
    });

    expect(deleteResponse.status).toBe(200);
    const deleteData = (await deleteResponse.json()) as SessionDeleteResult;
    expect(deleteData.success).toBe(true);

    // Wait briefly for process cleanup after session destruction
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify the finished marker does NOT exist (command was killed with session)
    const checkFinished = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId),
      body: JSON.stringify({
        command:
          'test -f /tmp/timeout-test-finished && echo "exists" || echo "not-exists"'
      })
    });

    expect(checkFinished.status).toBe(200);
    const finishData = (await checkFinished.json()) as ExecResult;
    expect(finishData.stdout.trim()).toBe('not-exists');

    // Cleanup marker files
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId),
      body: JSON.stringify({
        command: 'rm -f /tmp/timeout-test-started /tmp/timeout-test-finished'
      })
    });
  }, 30000);
});
