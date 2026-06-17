import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';
import {
  collectProcessStderr,
  collectProcessStdout,
  collectProcessStreamEvents,
  startProcessViaTestWorker,
  streamProcessViaTestWorker
} from './helpers/process-stream';

interface SandboxStateResponse {
  status: 'healthy' | 'stopped' | 'stopped_with_code' | 'stopping';
  lastChange: number;
  exitCode?: number;
}
/**
 * Streaming Operations Edge Case Tests
 *
 * Tests error handling and edge cases for streaming.
 * Basic streaming tests are in comprehensive-workflow.test.ts.
 *
 * This file focuses on:
 * - Command failures with non-zero exit codes
 * - Nonexistent commands (exit code 127)
 * - Chunked output delivery over time
 * - File content streaming
 */
describe('Streaming Operations Edge Cases', () => {
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

  test('should handle command failures with non-zero exit code', async () => {
    const process = await startProcessViaTestWorker(
      workerUrl,
      headers,
      'false'
    );
    const streamResponse = await streamProcessViaTestWorker(
      workerUrl,
      headers,
      process.id
    );

    const events = await collectProcessStreamEvents(streamResponse);

    const exitEvent = events.find((event) => event.type === 'exit');
    expect(exitEvent).toBeDefined();
    expect(exitEvent?.exitCode).not.toBe(0);
  }, 90000);

  test('should handle nonexistent commands with proper exit code', async () => {
    const process = await startProcessViaTestWorker(
      workerUrl,
      headers,
      'nonexistentcommand123'
    );
    const streamResponse = await streamProcessViaTestWorker(
      workerUrl,
      headers,
      process.id
    );

    expect(streamResponse.status).toBe(200);

    const events = await collectProcessStreamEvents(streamResponse);

    const exitEvent = events.find((event) => event.type === 'exit');
    expect(exitEvent).toBeDefined();
    expect(exitEvent?.exitCode).toBe(127); // Command not found

    const stderrData = collectProcessStderr(events);
    expect(stderrData.toLowerCase()).toMatch(/command not found|not found/);
  }, 90000);

  test('should handle streaming with multiple output chunks over time', async () => {
    // Tests that streaming correctly delivers output over ~2 seconds
    const process = await startProcessViaTestWorker(
      workerUrl,
      headers,
      'bash -c \'for i in 1 2 3; do echo "Chunk $i"; sleep 0.5; done; echo "DONE"\''
    );
    const streamResponse = await streamProcessViaTestWorker(
      workerUrl,
      headers,
      process.id
    );

    expect(streamResponse.status).toBe(200);

    const startTime = Date.now();
    const events = await collectProcessStreamEvents(streamResponse, 20);
    const duration = Date.now() - startTime;

    // Should take ~1.5s (3 × 0.5s sleeps)
    expect(duration).toBeGreaterThan(1000);
    expect(duration).toBeLessThan(10000);

    const output = collectProcessStdout(events);

    expect(output).toContain('Chunk 1');
    expect(output).toContain('Chunk 2');
    expect(output).toContain('Chunk 3');
    expect(output).toContain('DONE');

    const exitEvent = events.find((event) => event.type === 'exit');
    expect(exitEvent).toBeDefined();
    expect(exitEvent?.exitCode).toBe(0);
  }, 15000);

  test('should stream file contents', async () => {
    // Create a test file first
    const testPath = `/workspace/stream-test-${Date.now()}.txt`;
    const testContent =
      'Line 1\nLine 2\nLine 3\nThis is streaming file content.';

    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testPath, content: testContent }),
      signal: AbortSignal.timeout(5000)
    });

    // Stream the file back
    const streamResponse = await fetch(`${workerUrl}/api/read/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testPath }),
      signal: AbortSignal.timeout(5000)
    });

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('Content-Type')).toBe(
      'text/event-stream'
    );

    // Collect streamed content
    const reader = streamResponse.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let rawContent = '';
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      rawContent += decoder.decode(value, { stream: true });
    }

    // Parse SSE JSON events
    const lines = rawContent.split('\n').filter((l) => l.startsWith('data: '));
    const events = lines.map((l) => JSON.parse(l.slice(6)));

    // Should have metadata, chunk(s), and complete events
    const metadata = events.find((e) => e.type === 'metadata');
    const chunk = events.find((e) => e.type === 'chunk');
    const complete = events.find((e) => e.type === 'complete');

    expect(metadata).toBeDefined();
    expect(metadata.mimeType).toBe('text/plain');
    expect(chunk).toBeDefined();
    expect(chunk.data).toBe(testContent);
    expect(complete).toBeDefined();
    expect(complete.bytesRead).toBe(testContent.length);

    // Cleanup
    await fetch(`${workerUrl}/api/file/delete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testPath }),
      signal: AbortSignal.timeout(5000)
    });
  }, 30000);
});

describe('Streaming Operations - sleep after', () => {
  test('should keep sandbox alive during process streaming beyond sleepAfter value', async ({
    onTestFinished
  }) => {
    const sandbox = await createTestSandbox({ sleepAfter: '3s' });

    onTestFinished(() => cleanupTestSandbox(sandbox).catch());

    const { workerUrl } = sandbox;
    const headers = sandbox.headers();

    const process = await startProcessViaTestWorker(
      workerUrl,
      headers,
      "bash -c 'sleep 5; printf done'"
    );
    const streamResponse = await streamProcessViaTestWorker(
      workerUrl,
      headers,
      process.id
    );

    expect(streamResponse.status).toBe(200);

    const startTime = Date.now();
    const events = await collectProcessStreamEvents(streamResponse, 20);
    const duration = Date.now() - startTime;

    expect(duration).toBeGreaterThan(4500);

    const stdout = collectProcessStdout(events);
    const exitEvent = events.find((event) => event.type === 'exit');

    expect(stdout.trimEnd()).toBe('done');
    expect(exitEvent?.exitCode).toBe(0);

    // Poll until the sandbox reaches a stopped state (sleepAfter is 3s)
    const deadline = Date.now() + 30_000;
    let status: string | undefined;
    while (Date.now() < deadline) {
      const stateResponse = await fetch(`${workerUrl}/api/state`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000)
      });
      expect(stateResponse.status).toBe(200);
      const state = (await stateResponse.json()) as { status: string };
      status = state.status;
      if (status === 'stopped' || status === 'stopped_with_code') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Debugging
    if (status !== 'stopped' && status !== 'stopped_with_code') {
      console.log(
        'Sandbox Config',
        await fetch(`${workerUrl}/api/config`, { headers }).then((r) =>
          r.json()
        )
      );
    }
    expect(status).toMatch(/^(stopped|stopped_with_code)$/);
  }, 60_000);
});
