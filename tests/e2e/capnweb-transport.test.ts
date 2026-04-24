/**
 * Cap'n Web Transport E2E Tests
 *
 * Validates core sandbox operations work end-to-end through the capnweb
 * transport layer. These tests exercise:
 * - Command execution (exec)
 * - Streaming output (execStream)
 * - File operations (write, read, list, delete)
 * - Session isolation
 *
 * Skipped unless TEST_TRANSPORT=capnweb. Transport selection flows through
 * the X-Sandbox-Transport header to the test worker, which passes it to
 * getSandbox() as a per-instance transport option.
 */

import type {
  ExecEvent,
  ExecResult,
  ListFilesResult,
  ReadFileResult
} from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseSSEStream } from '../../packages/sandbox/src/sse-parser';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';

const isCapnweb = process.env.TEST_TRANSPORT === 'rpc';

describe.skipIf(!isCapnweb)("Cap'n Web Transport", () => {
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

  test('should execute a command and return stdout', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo hello-capnweb' })
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as ExecResult;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello-capnweb');
  });

  test('should handle command with non-zero exit code', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'sh -c "exit 42"' })
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as ExecResult;
    expect(result.exitCode).toBe(42);
  });

  test('should write and read a file', async () => {
    const testPath = sandbox!.uniquePath('capnweb-test.txt');
    const testContent = 'Hello from capnweb transport! 🚀';

    // Write
    const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testPath, content: testContent })
    });
    expect(writeResponse.status).toBe(200);

    // Read
    const readResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testPath })
    });
    expect(readResponse.status).toBe(200);
    const readResult = (await readResponse.json()) as ReadFileResult;
    expect(readResult.content).toBe(testContent);
  });

  test('should list files in a directory', async () => {
    const testDir = sandbox!.uniquePath('capnweb-list');

    // Create directory with files
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `mkdir -p ${testDir} && touch ${testDir}/a.txt ${testDir}/b.txt`
      })
    });

    const response = await fetch(`${workerUrl}/api/list-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testDir })
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as ListFilesResult;
    expect(result.files.length).toBeGreaterThanOrEqual(2);
    const names = result.files.map((f) => f.name);
    expect(names).toContain('a.txt');
    expect(names).toContain('b.txt');
  });

  test('should stream command output via execStream', async () => {
    const abortController = new AbortController();
    const response = await fetch(`${workerUrl}/api/execStream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo line1 && echo line2 && echo line3'
      }),
      signal: abortController.signal
    });

    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const events: ExecEvent[] = [];
    for await (const event of parseSSEStream<ExecEvent>(
      response.body!,
      abortController.signal
    )) {
      events.push(event);
      if (event.type === 'complete' || event.type === 'error') {
        break;
      }
    }

    // Should have stdout events and a complete event
    const stdoutEvents = events.filter((e) => e.type === 'stdout');
    const completeEvents = events.filter((e) => e.type === 'complete');

    expect(stdoutEvents.length).toBeGreaterThan(0);
    expect(completeEvents.length).toBe(1);

    // Combine all stdout output
    const allOutput = stdoutEvents.map((e) => e.data ?? '').join('');
    expect(allOutput).toContain('line1');
    expect(allOutput).toContain('line2');
    expect(allOutput).toContain('line3');

    // Complete event should show success
    const complete = completeEvents[0];
    expect(complete.exitCode).toBe(0);
  });

  test('should delete a file', async () => {
    const testPath = sandbox!.uniquePath('capnweb-delete.txt');

    // Create file
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: testPath,
        content: 'to be deleted'
      })
    });

    // Delete
    const deleteResponse = await fetch(`${workerUrl}/api/file/delete`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ path: testPath })
    });
    expect(deleteResponse.status).toBe(200);

    // Verify gone
    const existsResponse = await fetch(`${workerUrl}/api/file/exists`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testPath })
    });
    expect(existsResponse.status).toBe(200);
    const existsResult = (await existsResponse.json()) as {
      exists: boolean;
    };
    expect(existsResult.exists).toBe(false);
  });

  test('should create and use a separate session with isolated env', async () => {
    const sessionId = createUniqueSession();

    // Create session with custom env
    const createResponse = await fetch(`${workerUrl}/api/session/create`, {
      method: 'POST',
      headers: sandbox!.headers(),
      body: JSON.stringify({
        id: sessionId,
        env: { CAPNWEB_TEST: 'transport-works' }
      })
    });
    expect(createResponse.status).toBe(200);

    // Execute in that session to verify env
    const sessionHeaders = sandbox!.headers(sessionId);
    const execResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ command: 'echo $CAPNWEB_TEST' })
    });
    expect(execResponse.status).toBe(200);
    const result = (await execResponse.json()) as ExecResult;
    expect(result.stdout.trim()).toBe('transport-works');

    // The original session should NOT have this env var
    const defaultExecResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo $CAPNWEB_TEST' })
    });
    const defaultResult = (await defaultExecResponse.json()) as ExecResult;
    expect(defaultResult.stdout.trim()).toBe('');
  });
});
