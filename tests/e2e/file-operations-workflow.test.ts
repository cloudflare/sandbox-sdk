/**
 * E2E Test: File Operations Workflow
 *
 * Tests comprehensive file system operations including:
 * - Directory creation (mkdir)
 * - File deletion (deleteFile)
 * - File renaming (renameFile)
 * - File moving (moveFile)
 *
 * These tests validate realistic workflows like project scaffolding
 * and file manipulation across directory structures.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import { createSandboxId, createTestHeaders, fetchWithStartup, cleanupSandbox } from './helpers/test-fixtures';

describe('File Operations Workflow (E2E)', () => {
  let runner: WranglerDevRunner | null;
  let workerUrl: string;
  let currentSandboxId: string | null = null;

  beforeAll(async () => {
    // Get test worker URL (CI: uses deployed URL, Local: spawns wrangler dev)
    const result = await getTestWorkerUrl();
    workerUrl = result.url;
    runner = result.runner;
  }, 120000); // 2 minute timeout for wrangler startup

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

  test('should create nested directories', async () => {
    currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

    // Create nested directory structure
    const mkdirResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/project/src/components',

          recursive: true,
        }),
      }),
      { timeout: 60000, interval: 2000 }
    );

    const mkdirData = await mkdirResponse.json();
    expect(mkdirData.success).toBe(true);

    // Verify directory exists by listing it
    const lsResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'ls -la /workspace/project/src/components',

      }),
    });

    const lsData = await lsResponse.json();
    expect(lsResponse.status).toBe(200);
    expect(lsData.success).toBe(true);
    // Directory should exist (ls succeeds)
  }, 60000);

  test('should write files in subdirectories and read them back', async () => {
    currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

    // Create directory structure
    await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/app/config',

          recursive: true,
        }),
      }),
      { timeout: 60000, interval: 2000 }
    );

    // Write file in subdirectory
    const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/app/config/settings.json',
        content: JSON.stringify({ debug: true, port: 3000 }),

      }),
    });

    expect(writeResponse.status).toBe(200);

    // Read file back
    const readResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/app/config/settings.json',

      }),
    });

    const readData = await readResponse.json();
    expect(readResponse.status).toBe(200);
    expect(readData.content).toContain('debug');
    expect(readData.content).toContain('3000');
  }, 60000);

  test('should rename files', async () => {
    currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

    // Create directory and write file
    await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/docs',

          recursive: true,
        }),
      }),
      { timeout: 60000, interval: 2000 }
    );

    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/docs/README.txt',
        content: '# Project Documentation',

      }),
    });

    // Rename file from .txt to .md
    const renameResponse = await fetch(`${workerUrl}/api/file/rename`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        oldPath: '/workspace/docs/README.txt',
        newPath: '/workspace/docs/README.md',

      }),
    });

    expect(renameResponse.status).toBe(200);

    // Verify new file exists
    const readNewResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/docs/README.md',

      }),
    });

    const readNewData = await readNewResponse.json();
    expect(readNewResponse.status).toBe(200);
    expect(readNewData.content).toContain('Project Documentation');

    // Verify old file doesn't exist
    const readOldResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/docs/README.txt',

      }),
    });

    expect(readOldResponse.status).toBe(500); // Should fail - file doesn't exist
  }, 60000);

  test('should move files between directories', async () => {
    currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

    // Create two directories
    await vi.waitFor(
      async () => {
        await fetchWithStartup(`${workerUrl}/api/file/mkdir`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            path: '/workspace/source',

            recursive: true,
          }),
        });

        return fetch(`${workerUrl}/api/file/mkdir`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            path: '/workspace/destination',

            recursive: true,
          }),
        });
      },
      { timeout: 60000, interval: 2000 }
    );

    // Write file in source directory
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/source/data.json',
        content: JSON.stringify({ id: 1, name: 'test' }),

      }),
    });

    // Move file to destination
    const moveResponse = await fetch(`${workerUrl}/api/file/move`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sourcePath: '/workspace/source/data.json',
        destinationPath: '/workspace/destination/data.json',

      }),
    });

    expect(moveResponse.status).toBe(200);

    // Verify file exists in destination
    const readDestResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/destination/data.json',

      }),
    });

    const readDestData = await readDestResponse.json();
    expect(readDestResponse.status).toBe(200);
    expect(readDestData.content).toContain('test');

    // Verify file doesn't exist in source
    const readSourceResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/source/data.json',

      }),
    });

    expect(readSourceResponse.status).toBe(500); // Should fail - file moved
  }, 60000);

  test('should delete files', async () => {
    currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

    // Create directory and file
    await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/temp',

          recursive: true,
        }),
      }),
      { timeout: 60000, interval: 2000 }
    );

    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/temp/delete-me.txt',
        content: 'This file will be deleted',

      }),
    });

    // Verify file exists
    const readBeforeResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/temp/delete-me.txt',

      }),
    });

    expect(readBeforeResponse.status).toBe(200);

    // Delete file
    const deleteResponse = await fetch(`${workerUrl}/api/file/delete`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        path: '/workspace/temp/delete-me.txt',

      }),
    });

    expect(deleteResponse.status).toBe(200);

    // Verify file doesn't exist
    const readAfterResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/temp/delete-me.txt',

      }),
    });

    expect(readAfterResponse.status).toBe(500); // Should fail - file deleted
  }, 60000);

  test('should reject deleting directories with deleteFile', async () => {
    currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

    // Create a directory
    await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/test-dir',

          recursive: true,
        }),
      }),
      { timeout: 60000, interval: 2000 }
    );

    // Try to delete directory with deleteFile - should fail
    const deleteResponse = await fetch(`${workerUrl}/api/file/delete`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        path: '/workspace/test-dir',

      }),
    });

    // Should return error
    expect(deleteResponse.status).toBe(500);

    const deleteData = await deleteResponse.json();
    expect(deleteData.error).toContain('Cannot delete directory');
    expect(deleteData.error).toContain('deleteFile()');

    // Verify directory still exists
    const lsResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'ls -d /workspace/test-dir',

      }),
    });

    const lsData = await lsResponse.json();
    expect(lsResponse.status).toBe(200);
    expect(lsData.success).toBe(true); // Directory should still exist

    // Cleanup - delete directory properly using exec
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'rm -rf /workspace/test-dir',

      }),
    });
  }, 60000);

  test('should delete directories recursively using exec', async () => {
    currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

    // Create nested directory structure with files
    await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/cleanup/nested/deep',

          recursive: true,
        }),
      }),
      { timeout: 60000, interval: 2000 }
    );

    // Write files in different levels
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/cleanup/file1.txt',
        content: 'Level 1',

      }),
    });

    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/cleanup/nested/file2.txt',
        content: 'Level 2',

      }),
    });

    // Delete entire directory tree (use exec since deleteFile only works on files)
    const deleteResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'rm -rf /workspace/cleanup',

      }),
    });

    const deleteData = await deleteResponse.json();
    expect(deleteResponse.status).toBe(200);
    expect(deleteData.success).toBe(true);

    // Verify directory doesn't exist
    const lsResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'ls /workspace/cleanup',

      }),
    });

    const lsData = await lsResponse.json();
    // ls should fail or show empty result
    expect(lsData.success).toBe(false);
  }, 60000);

  test('should handle complete project scaffolding workflow', async () => {
    currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

    // Step 1: Create project directory structure
    await vi.waitFor(
      async () => {
        // Create main project directories
        await fetchWithStartup(`${workerUrl}/api/file/mkdir`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            path: '/workspace/myapp/src',

            recursive: true,
          }),
        });

        await fetch(`${workerUrl}/api/file/mkdir`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            path: '/workspace/myapp/tests',

            recursive: true,
          }),
        });

        return fetch(`${workerUrl}/api/file/mkdir`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            path: '/workspace/myapp/config',

            recursive: true,
          }),
        });
      },
      { timeout: 60000, interval: 2000 }
    );

    // Step 2: Write initial files
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/myapp/package.json',
        content: JSON.stringify({ name: 'myapp', version: '1.0.0' }),

      }),
    });

    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/myapp/src/index.js',
        content: 'console.log("Hello World");',

      }),
    });

    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/myapp/config/dev.json',
        content: JSON.stringify({ env: 'development' }),

      }),
    });

    // Step 3: Rename config file
    const renameResponse = await fetch(`${workerUrl}/api/file/rename`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        oldPath: '/workspace/myapp/config/dev.json',
        newPath: '/workspace/myapp/config/development.json',

      }),
    });

    expect(renameResponse.status).toBe(200);

    // Step 4: Move index.js to a lib subdirectory
    await fetch(`${workerUrl}/api/file/mkdir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/myapp/src/lib',

        recursive: true,
      }),
    });

    const moveResponse = await fetch(`${workerUrl}/api/file/move`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sourcePath: '/workspace/myapp/src/index.js',
        destinationPath: '/workspace/myapp/src/lib/index.js',

      }),
    });

    expect(moveResponse.status).toBe(200);

    // Step 5: Verify final structure
    const readPackageResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/myapp/package.json',

      }),
    });

    const packageData = await readPackageResponse.json();
    expect(readPackageResponse.status).toBe(200);
    expect(packageData.content).toContain('myapp');

    const readConfigResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/myapp/config/development.json',

      }),
    });

    const configData = await readConfigResponse.json();
    expect(readConfigResponse.status).toBe(200);
    expect(configData.content).toContain('development');

    const readIndexResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/myapp/src/lib/index.js',

      }),
    });

    const indexData = await readIndexResponse.json();
    expect(readIndexResponse.status).toBe(200);
    expect(indexData.content).toContain('Hello World');

    // Step 6: Cleanup - delete entire project (use exec since deleteFile only works on files)
    const deleteResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'rm -rf /workspace/myapp',

      }),
    });

    const deleteData = await deleteResponse.json();
    expect(deleteResponse.status).toBe(200);
    expect(deleteData.success).toBe(true);

    // Verify cleanup
    const lsResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'ls /workspace/myapp',

      }),
    });

    const lsData = await lsResponse.json();
    expect(lsData.success).toBe(false); // Directory should not exist
  }, 90000);

  test('should allow writing to any path (no path blocking - trust container isolation)', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Phase 0: Security simplification - we no longer block system paths
    // Users control their sandbox - container isolation provides real security
    // This test verifies we don't artificially restrict paths

    // Try to write to /tmp (should work - users control their sandbox)
    const writeResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/tmp/test-no-restrictions.txt',
          content: 'Users control their sandbox!',
        }),
      }),
      { timeout: 60000, interval: 2000 }
    );

    expect(writeResponse.status).toBe(200);
    const writeData = await writeResponse.json();
    expect(writeData.success).toBe(true);

    // Verify we can read it back
    const readResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/tmp/test-no-restrictions.txt',
      }),
    });

    expect(readResponse.status).toBe(200);
    const readData = await readResponse.json();
    expect(readData.content).toBe('Users control their sandbox!');
  }, 60000);

  test('should read text files with correct encoding and metadata', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create a text file
    await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/test.txt',
          content: 'Hello, World! This is a test.',
        }),
      }),
      { timeout: 60000, interval: 2000 }
    );

    // Read the file and check metadata
    const readResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/test.txt',
      }),
    });

    expect(readResponse.status).toBe(200);
    const readData = await readResponse.json();

    expect(readData.success).toBe(true);
    expect(readData.content).toBe('Hello, World! This is a test.');
    expect(readData.encoding).toBe('utf-8');
    expect(readData.isBinary).toBe(false);
    expect(readData.mimeType).toMatch(/text\/plain/);
    expect(readData.size).toBeGreaterThan(0);
  }, 60000);

  test('should write and read binary files with base64 encoding', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create a simple binary file (1x1 PNG - smallest valid PNG)
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jYlkKQAAAABJRU5ErkJggg==';

    // First create the file using exec with base64 decode
    await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `echo '${pngBase64}' | base64 -d > /workspace/test.png`,
        }),
      }),
      { timeout: 60000, interval: 2000 }
    );

    // Read the binary file
    const readResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/test.png',
      }),
    });

    expect(readResponse.status).toBe(200);
    const readData = await readResponse.json();

    expect(readData.success).toBe(true);
    expect(readData.encoding).toBe('base64');
    expect(readData.isBinary).toBe(true);
    expect(readData.mimeType).toMatch(/image\/png/);
    expect(readData.content).toBeTruthy();
    expect(readData.size).toBeGreaterThan(0);

    // Verify the content is valid base64
    expect(readData.content).toMatch(/^[A-Za-z0-9+/=]+$/);
  }, 60000);

  test('should detect JSON files as text', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    const jsonContent = JSON.stringify({ key: 'value', number: 42 });

    // Write JSON file
    await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/config.json',
          content: jsonContent,
        }),
      }),
      { timeout: 60000, interval: 2000 }
    );

    // Read and verify metadata
    const readResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/config.json',
      }),
    });

    expect(readResponse.status).toBe(200);
    const readData = await readResponse.json();

    expect(readData.success).toBe(true);
    expect(readData.content).toBe(jsonContent);
    expect(readData.encoding).toBe('utf-8');
    expect(readData.isBinary).toBe(false);
    expect(readData.mimeType).toMatch(/json/);
  }, 60000);

  test('should stream large text files', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create a larger text file
    const largeContent = 'Line content\n'.repeat(1000); // 13KB file

    await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/large.txt',
          content: largeContent,
        }),
      }),
      { timeout: 60000, interval: 2000 }
    );

    // Stream the file
    const streamResponse = await fetch(`${workerUrl}/api/read/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/large.txt',
      }),
    });

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toBe('text/event-stream');

    // Collect events from stream
    const reader = streamResponse.body?.getReader();
    expect(reader).toBeDefined();

    if (!reader) return;

    const decoder = new TextDecoder();
    let receivedMetadata = false;
    let receivedChunks = 0;
    let receivedComplete = false;
    let buffer = '';

    // Read entire stream - don't break early
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
    }

    // Process all buffered events
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const jsonStr = line.slice(6);
        try {
          const event = JSON.parse(jsonStr);

          if (event.type === 'metadata') {
            receivedMetadata = true;
            expect(event.encoding).toBe('utf-8');
            expect(event.isBinary).toBe(false);
            expect(event.mimeType).toMatch(/text\/plain/);
          } else if (event.type === 'chunk') {
            receivedChunks++;
            expect(event.data).toBeTruthy();
          } else if (event.type === 'complete') {
            receivedComplete = true;
            expect(event.bytesRead).toBe(13000);
          }
        } catch (e) {
          // Ignore parse errors for empty lines
        }
      }
    }

    expect(receivedMetadata).toBe(true);
    expect(receivedChunks).toBeGreaterThan(0);
    expect(receivedComplete).toBe(true);
  }, 60000);

  test('should return error when deleting nonexistent file', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Try to delete a file that doesn't exist
    const deleteResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/file/delete`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({
          path: '/workspace/this-file-does-not-exist.txt',
        }),
      }, { expectSuccess: false }), // Don't throw on error - we expect this to fail
      { timeout: 60000, interval: 2000 }
    );

    // Should return error with FILE_NOT_FOUND
    expect(deleteResponse.status).toBe(500);
    const errorData = await deleteResponse.json();
    expect(errorData.error).toBeTruthy();
    expect(errorData.error).toMatch(/not found|does not exist|no such file/i);
  }, 60000);

  test('should list files with metadata and permissions', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create directory with files including executable script
    await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/project',
          recursive: true,
        }),
      }),
      { timeout: 60000, interval: 2000 }
    );

    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/project/data.txt',
        content: 'Some data',
      }),
    });

    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "#!/bin/bash" > /workspace/project/script.sh && chmod +x /workspace/project/script.sh',
      }),
    });

    // List files and verify metadata
    const listResponse = await fetch(`${workerUrl}/api/list-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/project',
      }),
    });

    expect(listResponse.status).toBe(200);
    const listData = await listResponse.json();

    expect(listData.success).toBe(true);
    expect(listData.path).toBe('/workspace/project');
    expect(listData.files).toBeInstanceOf(Array);
    expect(listData.count).toBeGreaterThan(0);

    // Verify file has correct metadata and permissions
    const dataFile = listData.files.find((f: any) => f.name === 'data.txt');
    expect(dataFile).toBeDefined();
    expect(dataFile.type).toBe('file');
    expect(dataFile.absolutePath).toBe('/workspace/project/data.txt');
    expect(dataFile.relativePath).toBe('data.txt');
    expect(dataFile.size).toBeGreaterThan(0);
    expect(dataFile.mode).toMatch(/^[r-][w-][x-][r-][w-][x-][r-][w-][x-]$/);
    expect(dataFile.permissions.readable).toBe(true);
    expect(dataFile.permissions.writable).toBe(true);
    expect(dataFile.permissions.executable).toBe(false);

    // Verify executable script has correct permissions
    const scriptFile = listData.files.find((f: any) => f.name === 'script.sh');
    expect(scriptFile).toBeDefined();
    expect(scriptFile.permissions.executable).toBe(true);
  }, 60000);

  test('should list files recursively with correct relative paths', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create nested directory structure
    await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/tree/level1/level2',
          recursive: true,
        }),
      }),
      { timeout: 60000, interval: 2000 }
    );

    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/tree/root.txt',
        content: 'Root',
      }),
    });

    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/tree/level1/level2/deep.txt',
        content: 'Deep',
      }),
    });

    const listResponse = await fetch(`${workerUrl}/api/list-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/tree',
        options: { recursive: true },
      }),
    });

    expect(listResponse.status).toBe(200);
    const listData = await listResponse.json();

    expect(listData.success).toBe(true);

    // Verify relative paths are correct
    const rootFile = listData.files.find((f: any) => f.name === 'root.txt');
    expect(rootFile?.relativePath).toBe('root.txt');

    const deepFile = listData.files.find((f: any) => f.name === 'deep.txt');
    expect(deepFile?.relativePath).toBe('level1/level2/deep.txt');
  }, 60000);

  test('should handle listFiles errors appropriately', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Test non-existent directory
    const notFoundResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/list-files`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/does-not-exist',
        }),
      }, { expectSuccess: false }),
      { timeout: 60000, interval: 2000 }
    );

    expect(notFoundResponse.status).toBe(500);
    const notFoundData = await notFoundResponse.json();
    expect(notFoundData.error).toBeTruthy();
    expect(notFoundData.error).toMatch(/not found|does not exist/i);

    // Test listing a file instead of directory
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/file.txt',
        content: 'Not a directory',
      }),
    });

    const wrongTypeResponse = await fetch(`${workerUrl}/api/list-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/file.txt',
      }),
    });

    expect(wrongTypeResponse.status).toBe(500);
    const wrongTypeData = await wrongTypeResponse.json();
    expect(wrongTypeData.error).toMatch(/not a directory/i);
  }, 60000);
});
