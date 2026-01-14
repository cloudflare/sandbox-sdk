/**
 * File Watch Integration Tests
 *
 * Tests the file watching feature end-to-end:
 * - Starting a watch and receiving the 'watching' confirmation
 * - Detecting file creation, modification, and deletion
 * - Stopping a watch cleanly
 * - Filtering with include patterns
 * - Recursive vs non-recursive watching
 */

import type { FileWatchSSEEvent } from '@repo/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox,
  uniqueTestPath
} from './helpers/global-sandbox';

describe('File Watch Workflow', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let testDir: string;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
  }, 120000);

  /**
   * Helper to start a watch that allows performing actions after the watch is established.
   */
  async function watchWithActions<T>(
    path: string,
    options: {
      recursive?: boolean;
      include?: string[];
      timeoutMs?: number;
      stopAfterEvents?: number;
    } = {},
    actions: () => Promise<T>
  ): Promise<{
    events: FileWatchSSEEvent[];
    watchId: string | null;
    actionResult: T;
  }> {
    const { timeoutMs = 5000, stopAfterEvents = 20 } = options;

    const response = await fetch(`${workerUrl}/api/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path,
        recursive: options.recursive ?? true,
        include: options.include
      })
    });

    if (!response.ok || !response.body) {
      throw new Error(`Watch request failed: ${response.status}`);
    }

    const events: FileWatchSSEEvent[] = [];
    let watchId: string | null = null;
    let actionResult: T;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let actionsExecuted = false;

    const timeout = setTimeout(() => reader.cancel(), timeoutMs);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const event = JSON.parse(line.slice(6)) as FileWatchSSEEvent;
            events.push(event);

            if (event.type === 'watching') {
              watchId = event.watchId;
              // Execute actions after the watch is confirmed ready
              if (!actionsExecuted) {
                actionsExecuted = true;
                // inotifywait outputs "Setting up watches..." to stderr before it's ready
                // We need to give it time to actually establish all watches before performing actions
                await new Promise((r) => setTimeout(r, 1500));
                actionResult = await actions();
                // Give events time to propagate through the SSE stream
                // Longer delay for WebSocket transport which has additional buffering
                await new Promise((r) => setTimeout(r, 3000));
              }
            }

            if (
              event.type === 'stopped' ||
              event.type === 'error' ||
              events.length >= stopAfterEvents
            ) {
              reader.cancel();
              break;
            }
          }
        }
      }
    } catch (e) {
      // Reader cancelled - expected
    } finally {
      clearTimeout(timeout);
    }

    return { events, watchId, actionResult: actionResult! };
  }

  /**
   * Helper to start a watch and collect events until stopped or timeout.
   */
  async function watchAndCollect(
    path: string,
    options: {
      recursive?: boolean;
      include?: string[];
      timeoutMs?: number;
      stopAfterEvents?: number;
    } = {}
  ): Promise<{ events: FileWatchSSEEvent[]; watchId: string | null }> {
    const result = await watchWithActions(path, options, async () => {});
    return { events: result.events, watchId: result.watchId };
  }

  /**
   * Helper to create a file via the API.
   */
  async function createFile(path: string, content: string): Promise<void> {
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path, content })
    });
  }

  /**
   * Helper to create a directory via the API.
   */
  async function createDir(path: string): Promise<void> {
    await fetch(`${workerUrl}/api/file/mkdir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path, recursive: true })
    });
  }

  /**
   * Helper to delete a file via the API.
   */
  async function deleteFile(path: string): Promise<void> {
    await fetch(`${workerUrl}/api/file/delete`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ path })
    });
  }

  test('should establish watch and receive watching event', async () => {
    testDir = uniqueTestPath('watch-establish');
    await createDir(testDir);

    const { events, watchId } = await watchAndCollect(testDir, {
      timeoutMs: 2000,
      stopAfterEvents: 1
    });

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe('watching');
    expect(watchId).toBeTruthy();

    if (events[0].type === 'watching') {
      expect(events[0].path).toBe(testDir);
    }
  }, 30000);

  test('should detect file creation', async () => {
    testDir = uniqueTestPath('watch-create');
    await createDir(testDir);

    // Start watch and create file after watch is confirmed ready
    const { events } = await watchWithActions(
      testDir,
      { timeoutMs: 5000, stopAfterEvents: 5 },
      async () => {
        await createFile(`${testDir}/newfile.txt`, 'hello');
      }
    );

    console.log('[DEBUG] Collected events:', JSON.stringify(events, null, 2));

    const createEvent = events.find(
      (e) => e.type === 'event' && e.eventType === 'create'
    );
    expect(createEvent).toBeDefined();

    if (createEvent?.type === 'event') {
      expect(createEvent.path).toContain('newfile.txt');
    }
  }, 30000);

  test('should detect file modification', async () => {
    testDir = uniqueTestPath('watch-modify');
    await createDir(testDir);
    await createFile(`${testDir}/existing.txt`, 'initial');

    // Start watch and modify file after watch is confirmed ready
    const { events } = await watchWithActions(
      testDir,
      { timeoutMs: 5000, stopAfterEvents: 5 },
      async () => {
        await createFile(`${testDir}/existing.txt`, 'modified content');
      }
    );

    // Modification might show as 'modify' or 'create' depending on how editor writes
    const modifyEvent = events.find(
      (e) =>
        e.type === 'event' &&
        (e.eventType === 'modify' || e.eventType === 'create') &&
        e.path.includes('existing.txt')
    );
    expect(modifyEvent).toBeDefined();
  }, 30000);

  test('should detect file deletion', async () => {
    testDir = uniqueTestPath('watch-delete');
    await createDir(testDir);
    await createFile(`${testDir}/todelete.txt`, 'delete me');

    // Start watch and delete file after watch is confirmed ready
    const { events } = await watchWithActions(
      testDir,
      { timeoutMs: 8000, stopAfterEvents: 5 },
      async () => {
        // Small delay to ensure watch is fully ready
        await new Promise((r) => setTimeout(r, 500));
        await deleteFile(`${testDir}/todelete.txt`);
      }
    );

    console.log('[DEBUG] Delete test events:', JSON.stringify(events, null, 2));

    const deleteEvent = events.find(
      (e) => e.type === 'event' && e.eventType === 'delete'
    );
    expect(deleteEvent).toBeDefined();

    if (deleteEvent?.type === 'event') {
      expect(deleteEvent.path).toContain('todelete.txt');
    }
  }, 30000);

  test('should filter events with include pattern', async () => {
    testDir = uniqueTestPath('watch-filter');
    await createDir(testDir);

    // Start watch and create files after watch is confirmed ready
    const { events } = await watchWithActions(
      testDir,
      { include: ['*.ts'], timeoutMs: 10000, stopAfterEvents: 10 },
      async () => {
        // Create both .ts and .js files
        await createFile(`${testDir}/code.ts`, 'typescript');
        await createFile(`${testDir}/code.js`, 'javascript');
        await createFile(`${testDir}/another.ts`, 'more typescript');
      }
    );

    const fileEvents = events.filter((e) => e.type === 'event');

    // Should only see .ts files
    const tsEvents = fileEvents.filter(
      (e) => e.type === 'event' && e.path.endsWith('.ts')
    );
    const jsEvents = fileEvents.filter(
      (e) => e.type === 'event' && e.path.endsWith('.js')
    );

    expect(tsEvents.length).toBeGreaterThan(0);
    expect(jsEvents.length).toBe(0);
  }, 30000);

  test('should stop watch via API', async () => {
    testDir = uniqueTestPath('watch-stop');
    await createDir(testDir);

    // Start a watch
    const response = await fetch(`${workerUrl}/api/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testDir })
    });

    expect(response.body).toBeTruthy();
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Read until we get the watching event
    let watchId: string | null = null;
    while (!watchId) {
      const { value } = await reader.read();
      const text = decoder.decode(value);
      const match = text.match(/"watchId":"([^"]+)"/);
      if (match) watchId = match[1];
    }

    expect(watchId).toBeTruthy();

    // Stop the watch
    const stopResponse = await fetch(`${workerUrl}/api/watch/stop`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ watchId })
    });

    expect(stopResponse.ok).toBe(true);
    const stopResult = (await stopResponse.json()) as { success: boolean };
    expect(stopResult.success).toBe(true);

    reader.cancel();
  }, 30000);

  test('should list active watches', async () => {
    testDir = uniqueTestPath('watch-list');
    await createDir(testDir);

    // Start a watch
    const response = await fetch(`${workerUrl}/api/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testDir })
    });

    // Wait for watch to establish
    expect(response.body).toBeTruthy();
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let watchId: string | null = null;

    while (!watchId) {
      const { value } = await reader.read();
      const text = decoder.decode(value);
      const match = text.match(/"watchId":"([^"]+)"/);
      if (match) watchId = match[1];
    }

    // List watches
    const listResponse = await fetch(`${workerUrl}/api/watch/list`, {
      method: 'GET',
      headers
    });

    expect(listResponse.ok).toBe(true);
    const listResult = (await listResponse.json()) as {
      success: boolean;
      watches: Array<{ id: string; path: string }>;
      count: number;
    };

    expect(listResult.success).toBe(true);
    expect(listResult.count).toBeGreaterThanOrEqual(1);

    const ourWatch = listResult.watches.find((w) => w.id === watchId);
    expect(ourWatch).toBeDefined();
    expect(ourWatch?.path).toBe(testDir);

    // Cleanup
    await fetch(`${workerUrl}/api/watch/stop`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ watchId })
    });

    reader.cancel();
  }, 30000);

  test('should return error for non-existent path', async () => {
    const response = await fetch(`${workerUrl}/api/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: '/nonexistent/path/that/does/not/exist' })
    });

    console.log(
      '[DEBUG] Non-existent path response:',
      response.status,
      response.ok
    );

    // Should get an error response (either 4xx/5xx or error in body)
    if (!response.ok) {
      // Non-OK response is expected - pass
      expect(response.ok).toBe(false);
      // Verify we get meaningful error content
      const body = await response.text();
      console.log('[DEBUG] Error response body:', body);
      expect(body).toMatch(/error|not found|does not exist/i);
      return;
    }

    // If we get a 200, it should be an SSE stream with an error event
    // Over WebSocket transport, errors may throw instead of returning data
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let streamError: Error | null = null;

      // Read multiple chunks in case the error comes later
      const timeout = setTimeout(() => reader.cancel(), 3000);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          console.log('[DEBUG] Received SSE chunk:', text.substring(0, 500));
          // Check if we have an error indication
          if (text.match(/error|not found|does not exist/i)) {
            break;
          }
        }
      } catch (e) {
        // Stream error or cancelled - capture the error
        streamError = e instanceof Error ? e : new Error(String(e));
        console.log('[DEBUG] Stream error:', streamError.message);
      } finally {
        clearTimeout(timeout);
        reader.cancel().catch(() => {});
      }

      console.log('[DEBUG] Final SSE text:', text);
      console.log('[DEBUG] Stream error:', streamError?.message);

      // Should contain an error message in either the text or the stream error
      const errorContent = text || streamError?.message || '';
      expect(errorContent).toMatch(/error|not found|does not exist/i);
    }
  }, 30000);

  test('should exclude patterns from events', async () => {
    testDir = uniqueTestPath('watch-exclude');
    await createDir(testDir);
    await createDir(`${testDir}/node_modules`);
    await createDir(`${testDir}/.git`);

    // Start watch and create files after watch is confirmed ready
    const { events } = await watchWithActions(
      testDir,
      { timeoutMs: 12000, stopAfterEvents: 10 },
      async () => {
        // Small delay to ensure watch is fully ready
        await new Promise((r) => setTimeout(r, 500));
        // Create files in excluded and non-excluded directories
        // Add delays between operations to avoid race conditions
        await createFile(`${testDir}/app.ts`, 'app code');
        await new Promise((r) => setTimeout(r, 300));
        await createFile(`${testDir}/node_modules/dep.js`, 'dependency');
        await new Promise((r) => setTimeout(r, 300));
        await createFile(`${testDir}/.git/config`, 'git config');
        await new Promise((r) => setTimeout(r, 300));
        await createFile(`${testDir}/index.ts`, 'index');
      }
    );

    console.log(
      '[DEBUG] Exclude test events:',
      JSON.stringify(events, null, 2)
    );

    const fileEvents = events.filter((e) => e.type === 'event');

    // Should see events for app.ts and index.ts
    const appEvents = fileEvents.filter(
      (e) => e.type === 'event' && e.path.includes('app.ts')
    );
    expect(appEvents.length).toBeGreaterThan(0);

    // Should NOT see events for node_modules (default exclude)
    const nodeModulesEvents = fileEvents.filter(
      (e) => e.type === 'event' && e.path.includes('node_modules')
    );
    expect(nodeModulesEvents.length).toBe(0);

    // Should NOT see events for .git (default exclude)
    const gitEvents = fileEvents.filter(
      (e) => e.type === 'event' && e.path.includes('.git')
    );
    expect(gitEvents.length).toBe(0);
  }, 30000);
});
