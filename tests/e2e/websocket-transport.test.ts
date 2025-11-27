/**
 * E2E Test: WebSocket Transport
 *
 * Tests that SDK operations work correctly when using WebSocket transport
 * instead of HTTP transport. This verifies the WebSocket control plane
 * multiplexing implementation.
 *
 * These tests mirror the HTTP tests but use the X-Use-WebSocket header
 * to enable WebSocket transport mode.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type {
  WriteFileResult,
  ReadFileResult,
  MkdirResult,
  ListFilesResult,
  ExecResult
} from '@repo/shared';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import {
  createSandboxId,
  createTestHeaders,
  cleanupSandbox
} from './helpers/test-fixtures';

describe('WebSocket Transport (E2E)', () => {
  let runner: WranglerDevRunner | null;
  let workerUrl: string;
  let currentSandboxId: string | null = null;

  // Helper to create headers with WebSocket transport enabled
  const createWSHeaders = (sandboxId: string) =>
    createTestHeaders(sandboxId, { useWebSocket: true });

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

  describe('File Operations via WebSocket', () => {
    test('should create directories via WebSocket transport', async () => {
      currentSandboxId = createSandboxId();
      const headers = createWSHeaders(currentSandboxId);

      // Create nested directory structure
      const mkdirResponse = await fetch(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-test/nested/directory',
          recursive: true
        })
      });

      const mkdirData = (await mkdirResponse.json()) as MkdirResult;
      expect(mkdirData.success).toBe(true);

      // Verify directory exists
      const lsResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'ls -la /workspace/ws-test/nested/directory'
        })
      });

      const lsData = (await lsResponse.json()) as ExecResult;
      expect(lsResponse.status).toBe(200);
      expect(lsData.success).toBe(true);
    }, 90000);

    test('should write and read files via WebSocket transport', async () => {
      currentSandboxId = createSandboxId();
      const headers = createWSHeaders(currentSandboxId);

      // Create directory
      await fetch(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-files',
          recursive: true
        })
      });

      // Write file
      const content = JSON.stringify({
        transport: 'websocket',
        timestamp: Date.now()
      });

      const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-files/config.json',
          content
        })
      });

      expect(writeResponse.status).toBe(200);

      // Read file back
      const readResponse = await fetch(`${workerUrl}/api/file/read`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-files/config.json'
        })
      });

      const readData = (await readResponse.json()) as ReadFileResult;
      expect(readResponse.status).toBe(200);
      expect(readData.content).toContain('websocket');
    }, 90000);

    test('should delete files via WebSocket transport', async () => {
      currentSandboxId = createSandboxId();
      const headers = createWSHeaders(currentSandboxId);

      // Create and write file
      await fetch(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-delete',
          recursive: true
        })
      });

      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-delete/temp.txt',
          content: 'Delete me via WebSocket'
        })
      });

      // Delete file
      const deleteResponse = await fetch(`${workerUrl}/api/file/delete`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-delete/temp.txt'
        })
      });

      expect(deleteResponse.status).toBe(200);

      // Verify file is deleted
      const readResponse = await fetch(`${workerUrl}/api/file/read`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-delete/temp.txt'
        })
      });

      expect(readResponse.status).toBe(500); // File not found
    }, 90000);

    test('should list files via WebSocket transport', async () => {
      currentSandboxId = createSandboxId();
      const headers = createWSHeaders(currentSandboxId);

      // Create directory with files
      await fetch(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-list',
          recursive: true
        })
      });

      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-list/file1.txt',
          content: 'File 1'
        })
      });

      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-list/file2.txt',
          content: 'File 2'
        })
      });

      // List files
      const listResponse = await fetch(`${workerUrl}/api/list-files`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-list'
        })
      });

      expect(listResponse.status).toBe(200);
      const listData = (await listResponse.json()) as ListFilesResult;

      expect(listData.success).toBe(true);
      expect(listData.count).toBe(2);
      expect(listData.files.map((f) => f.name).sort()).toEqual([
        'file1.txt',
        'file2.txt'
      ]);
    }, 90000);
  });

  describe('Command Execution via WebSocket', () => {
    test('should execute commands via WebSocket transport', async () => {
      currentSandboxId = createSandboxId();
      const headers = createWSHeaders(currentSandboxId);

      const execResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'echo "WebSocket transport works!"'
        })
      });

      const execData = (await execResponse.json()) as ExecResult;
      expect(execResponse.status).toBe(200);
      expect(execData.success).toBe(true);
      expect(execData.stdout).toContain('WebSocket transport works!');
    }, 90000);

    test('should handle command with environment variables via WebSocket', async () => {
      currentSandboxId = createSandboxId();
      const headers = createWSHeaders(currentSandboxId);

      const execResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'echo "Transport: $TRANSPORT_MODE"',
          env: { TRANSPORT_MODE: 'websocket' }
        })
      });

      const execData = (await execResponse.json()) as ExecResult;
      expect(execResponse.status).toBe(200);
      expect(execData.stdout).toContain('Transport: websocket');
    }, 90000);

    test('should handle command failures via WebSocket', async () => {
      currentSandboxId = createSandboxId();
      const headers = createWSHeaders(currentSandboxId);

      const execResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'exit 42'
        })
      });

      const execData = (await execResponse.json()) as ExecResult;
      expect(execResponse.status).toBe(200);
      expect(execData.exitCode).toBe(42);
      expect(execData.success).toBe(false);
    }, 90000);
  });

  describe('Multiple Operations via WebSocket', () => {
    test('should handle many sequential operations efficiently', async () => {
      currentSandboxId = createSandboxId();
      const headers = createWSHeaders(currentSandboxId);

      // Create base directory
      await fetch(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-batch',
          recursive: true
        })
      });

      // Perform many file operations (this is where WebSocket shines)
      const operationCount = 10;
      const startTime = Date.now();

      for (let i = 0; i < operationCount; i++) {
        // Write file
        await fetch(`${workerUrl}/api/file/write`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            path: `/workspace/ws-batch/file${i}.txt`,
            content: `Content ${i}`
          })
        });

        // Read file back
        const readResponse = await fetch(`${workerUrl}/api/file/read`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            path: `/workspace/ws-batch/file${i}.txt`
          })
        });

        const readData = (await readResponse.json()) as ReadFileResult;
        expect(readData.content).toBe(`Content ${i}`);
      }

      const duration = Date.now() - startTime;
      console.log(
        `WebSocket: ${operationCount * 2} operations completed in ${duration}ms`
      );

      // Verify all files exist
      const listResponse = await fetch(`${workerUrl}/api/list-files`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-batch'
        })
      });

      const listData = (await listResponse.json()) as ListFilesResult;
      expect(listData.count).toBe(operationCount);
    }, 120000);

    test('should handle mixed operations via WebSocket', async () => {
      currentSandboxId = createSandboxId();
      const headers = createWSHeaders(currentSandboxId);

      // Create directory structure
      await fetch(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-mixed/src',
          recursive: true
        })
      });

      // Write a script
      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-mixed/src/script.sh',
          content: '#!/bin/bash\necho "Hello from WebSocket!"'
        })
      });

      // Make it executable
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'chmod +x /workspace/ws-mixed/src/script.sh'
        })
      });

      // Execute the script
      const execResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: '/workspace/ws-mixed/src/script.sh'
        })
      });

      const execData = (await execResponse.json()) as ExecResult;
      expect(execData.success).toBe(true);
      expect(execData.stdout).toContain('Hello from WebSocket!');

      // Clean up
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'rm -rf /workspace/ws-mixed'
        })
      });
    }, 90000);
  });

  describe('WebSocket vs HTTP Comparison', () => {
    test('should work identically to HTTP transport', async () => {
      const sandboxId = createSandboxId();
      currentSandboxId = sandboxId;

      // Test with WebSocket
      const wsHeaders = createTestHeaders(sandboxId, { useWebSocket: true });

      await fetch(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers: wsHeaders,
        body: JSON.stringify({
          path: '/workspace/compare-test',
          recursive: true
        })
      });

      const wsWriteResponse = await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers: wsHeaders,
        body: JSON.stringify({
          path: '/workspace/compare-test/ws-file.txt',
          content: 'Written via WebSocket'
        })
      });
      expect(wsWriteResponse.status).toBe(200);

      // Now test with HTTP (same sandbox, different transport)
      const httpHeaders = createTestHeaders(sandboxId); // No useWebSocket

      const httpWriteResponse = await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers: httpHeaders,
        body: JSON.stringify({
          path: '/workspace/compare-test/http-file.txt',
          content: 'Written via HTTP'
        })
      });
      expect(httpWriteResponse.status).toBe(200);

      // Read both files to verify they work
      const wsReadResponse = await fetch(`${workerUrl}/api/file/read`, {
        method: 'POST',
        headers: wsHeaders,
        body: JSON.stringify({
          path: '/workspace/compare-test/ws-file.txt'
        })
      });
      const wsReadData = (await wsReadResponse.json()) as ReadFileResult;
      expect(wsReadData.content).toBe('Written via WebSocket');

      const httpReadResponse = await fetch(`${workerUrl}/api/file/read`, {
        method: 'POST',
        headers: httpHeaders,
        body: JSON.stringify({
          path: '/workspace/compare-test/http-file.txt'
        })
      });
      const httpReadData = (await httpReadResponse.json()) as ReadFileResult;
      expect(httpReadData.content).toBe('Written via HTTP');
    }, 90000);
  });
});
