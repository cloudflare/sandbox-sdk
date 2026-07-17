import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

/**
 * Streaming Operations E2E Tests
 *
 * Verifies that file contents can be streamed over EventStream.
 */
describe('Streaming Operations', () => {
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
