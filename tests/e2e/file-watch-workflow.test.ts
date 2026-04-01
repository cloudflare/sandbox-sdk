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

import type { CheckChangesResult, FileWatchSSEEvent } from '@repo/shared';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from 'vitest';
import { parseSSEStream } from '../../packages/sandbox/src/sse-parser';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';

describe('File Watch Workflow', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;
  let testDir: string;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
  }, 120000);

  beforeEach(async () => {
    if (!sandbox) {
      throw new Error('Test sandbox not initialized');
    }
    headers = sandbox.headers(createUniqueSession());
  });

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
  });

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

    // watch() blocks until the watcher is established, so by the time
    // the response arrives the filesystem watcher is ready.
    const actionResult = await actions();

    const events: FileWatchSSEEvent[] = [];
    let watchId: string | null = null;
    const signal = AbortSignal.timeout(timeoutMs);

    try {
      for await (const event of parseSSEStream<FileWatchSSEEvent>(
        response.body,
        signal
      )) {
        events.push(event);

        if (event.type === 'watching') {
          watchId = event.watchId;
        }

        if (
          event.type === 'stopped' ||
          event.type === 'error' ||
          events.length >= stopAfterEvents
        ) {
          break;
        }
      }
    } catch (error) {
      if (
        !(
          signal.aborted &&
          error instanceof Error &&
          error.message === 'Operation was aborted'
        )
      ) {
        throw error;
      }
    }

    return { events, watchId, actionResult };
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

  async function expectOk(response: Response, context: string): Promise<void> {
    if (response.ok) {
      return;
    }

    const body = await response.text();
    throw new Error(`${context} failed with ${response.status}: ${body}`);
  }

  /**
   * Helper to create a file via the API.
   */
  async function createFile(path: string, content: string): Promise<void> {
    const response = await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path, content })
    });
    await expectOk(response, `createFile(${path})`);
  }

  /**
   * Helper to create a directory via the API.
   */
  async function createDir(path: string): Promise<void> {
    const response = await fetch(`${workerUrl}/api/file/mkdir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path, recursive: true })
    });
    await expectOk(response, `createDir(${path})`);
  }

  /**
   * Helper to delete a file via the API.
   */
  async function deleteFile(path: string): Promise<void> {
    const response = await fetch(`${workerUrl}/api/file/delete`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ path })
    });
    await expectOk(response, `deleteFile(${path})`);
  }

  async function checkChanges(
    path: string,
    options: {
      recursive?: boolean;
      include?: string[];
      exclude?: string[];
      since?: string;
    } = {}
  ): Promise<CheckChangesResult> {
    const response = await fetch(`${workerUrl}/api/watch/check`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path,
        recursive: options.recursive,
        include: options.include,
        exclude: options.exclude,
        since: options.since
      })
    });

    await expectOk(response, `checkChanges(${path})`);
    return (await response.json()) as CheckChangesResult;
  }

  test('should establish watch and receive watching event', async () => {
    testDir = sandbox!.uniquePath('watch-establish');
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

  test('should report unchanged when starting retained change tracking', async () => {
    testDir = sandbox!.uniquePath('watch-check-baseline');
    await createDir(testDir);

    const result = await checkChanges(testDir);

    expect(result.status).toBe('unchanged');
    expect(result.version).toMatch(/^watch-\d+-\d+:0$/);
  }, 30000);

  test('should retain changed state across reconnect gaps', async () => {
    testDir = sandbox!.uniquePath('watch-check-retain');
    await createDir(testDir);

    const first = await checkChanges(testDir);
    expect(first.status).toBe('unchanged');

    await createFile(`${testDir}/changed.txt`, 'hello');

    const second = await checkChanges(testDir, {
      since: first.version
    });

    expect(second.status).toBe('changed');
    expect(second.version).not.toBe(first.version);
  }, 30000);

  test('should report unchanged when no files changed since the version', async () => {
    testDir = sandbox!.uniquePath('watch-check-unchanged');
    await createDir(testDir);

    const first = await checkChanges(testDir);
    const second = await checkChanges(testDir, {
      since: first.version
    });

    expect(second.status).toBe('unchanged');
    expect(second.version).toBe(first.version);
  }, 30000);

  test('should detect file creation', async () => {
    testDir = sandbox!.uniquePath('watch-create');
    await createDir(testDir);

    // Start watch and create file after watch is confirmed ready
    const { events } = await watchWithActions(
      testDir,
      { timeoutMs: 8000, stopAfterEvents: 5 },
      async () => {
        await createFile(`${testDir}/newfile.txt`, 'hello');
      }
    );

    const createEvent = events.find(
      (e) => e.type === 'event' && e.eventType === 'create'
    );
    expect(createEvent).toBeDefined();

    if (createEvent?.type === 'event') {
      expect(createEvent.path).toContain('newfile.txt');
    }
  }, 30000);

  test('should detect file modification', async () => {
    testDir = sandbox!.uniquePath('watch-modify');
    await createDir(testDir);
    await createFile(`${testDir}/existing.txt`, 'initial');

    // Start watch and modify file after watch is confirmed ready
    const { events } = await watchWithActions(
      testDir,
      { timeoutMs: 8000, stopAfterEvents: 5 },
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
    testDir = sandbox!.uniquePath('watch-delete');
    await createDir(testDir);
    await createFile(`${testDir}/todelete.txt`, 'delete me');

    // Start watch and delete file after watch is confirmed ready
    const { events } = await watchWithActions(
      testDir,
      { timeoutMs: 8000, stopAfterEvents: 5 },
      async () => {
        await deleteFile(`${testDir}/todelete.txt`);
      }
    );

    const deleteEvent = events.find(
      (e) => e.type === 'event' && e.eventType === 'delete'
    );
    expect(deleteEvent).toBeDefined();

    if (deleteEvent?.type === 'event') {
      expect(deleteEvent.path).toContain('todelete.txt');
    }
  }, 30000);

  test('should filter events with include pattern', async () => {
    testDir = sandbox!.uniquePath('watch-filter');
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

  test('should stop watch when client closes stream', async () => {
    testDir = sandbox!.uniquePath('watch-stop');
    await createDir(testDir);

    const response = await fetch(`${workerUrl}/api/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testDir })
    });

    expect(response.body).toBeTruthy();
    if (!response.body) return;

    // watch() blocks until established, so the response arriving means
    // the watcher is ready. Read one chunk to confirm the stream is live.
    const reader = response.body.getReader();
    const { done } = await reader.read();
    expect(done).toBe(false);

    // Client-side cancellation should stop the server watch
    await reader.cancel();

    // Starting another watch on same path should work immediately if cleanup succeeded
    const secondResponse = await fetch(`${workerUrl}/api/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testDir })
    });
    expect(secondResponse.ok).toBe(true);
    await secondResponse.body?.cancel();
  }, 30000);

  test('should return error for non-existent path', async () => {
    const response = await fetch(`${workerUrl}/api/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/nonexistent/path/that/does/not/exist'
      })
    });

    // watch() throws when the watcher fails to establish, so the test
    // worker's error handler converts it to a non-200 response.
    expect(response.ok).toBe(false);
    const body = await response.text();
    expect(body).toMatch(
      /error|not found|does not exist|permission denied|file_not_found|permission_denied/i
    );
  }, 30000);

  test('should exclude patterns from events', async () => {
    testDir = sandbox!.uniquePath('watch-exclude');
    await createDir(testDir);
    await createDir(`${testDir}/node_modules`);
    await createDir(`${testDir}/.git`);

    // Start watch and create files after watch is confirmed ready
    // Use a short timeout: excluded dirs mean fewer events arrive, so we
    // only need to wait long enough for the non-excluded file events.
    const { events } = await watchWithActions(
      testDir,
      { timeoutMs: 5000, stopAfterEvents: 5 },
      async () => {
        // Create files in excluded and non-excluded directories
        await createFile(`${testDir}/app.ts`, 'app code');
        await createFile(`${testDir}/node_modules/dep.js`, 'dependency');
        await createFile(`${testDir}/.git/config`, 'git config');
        await createFile(`${testDir}/index.ts`, 'index');
      }
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
