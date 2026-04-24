/**
 * File Operations Error Handling Tests
 *
 * Tests error cases and edge cases for file operations.
 * Happy path tests (mkdir, write, read, rename, move, delete, list) are in comprehensive-workflow.test.ts.
 *
 * This file focuses on:
 * - Deleting directories with deleteFile (should reject)
 * - Deleting nonexistent files
 * - listFiles errors (nonexistent dir, file instead of dir)
 * - Hidden file handling
 */

import type { FileInfo, ListFilesResult, ReadFileResult } from '@repo/shared';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';
import type { ErrorResponse } from './test-worker/types';

describe('File Operations Error Handling', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;
  let testDir: string;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers(createUniqueSession());
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  // Use unique directory for each test to avoid conflicts
  beforeEach(() => {
    testDir = sandbox!.uniquePath('file-ops');
  });

  test('should reject deleting directories with deleteFile', async () => {
    const dirPath = `${testDir}/test-dir`;

    // Create a directory
    await fetch(`${workerUrl}/api/file/mkdir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: dirPath,
        recursive: true
      })
    });

    // Try to delete directory with deleteFile - should fail
    const deleteResponse = await fetch(`${workerUrl}/api/file/delete`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        path: dirPath
      })
    });

    expect(deleteResponse.status).toBe(500);
    const deleteData = (await deleteResponse.json()) as ErrorResponse;
    expect(deleteData.error).toContain('Cannot delete directory');
    expect(deleteData.error).toContain('deleteFile()');

    // Verify directory still exists
    const lsResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `ls -d ${dirPath}`
      })
    });

    const lsData = (await lsResponse.json()) as ReadFileResult;
    expect(lsResponse.status).toBe(200);
    expect(lsData.success).toBe(true);
  }, 90000);

  test('should return error when deleting nonexistent file', async () => {
    const deleteResponse = await fetch(`${workerUrl}/api/file/delete`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        path: `${testDir}/this-file-does-not-exist.txt`
      })
    });

    expect(deleteResponse.status).toBe(404);
    const errorData = (await deleteResponse.json()) as ErrorResponse;
    expect(errorData.error).toBeTruthy();
    expect(errorData.error).toMatch(/not found|does not exist|no such file/i);
  }, 90000);

  test('should handle listFiles errors appropriately', async () => {
    // Test non-existent directory
    const notFoundResponse = await fetch(`${workerUrl}/api/list-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: `${testDir}/nonexistent-directory`
      })
    });

    expect(notFoundResponse.status).toBe(404);
    const notFoundData = (await notFoundResponse.json()) as ErrorResponse;
    expect(notFoundData.error).toBeTruthy();
    expect(notFoundData.error).toMatch(
      /not found|does not exist|no such file/i
    );

    // Test file instead of directory
    const filePath = `${testDir}/test-file.txt`;
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: filePath,
        content: 'test'
      })
    });

    const fileAsDir = await fetch(`${workerUrl}/api/list-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: filePath
      })
    });

    expect(fileAsDir.status).toBe(500);
    const fileAsDirData = (await fileAsDir.json()) as ErrorResponse;
    expect(fileAsDirData.error).toBeTruthy();
    expect(fileAsDirData.error).toMatch(/not a directory|is not a directory/i);
  }, 90000);

  // Regression test for #196: hidden files in hidden directories
  test('should list files in hidden directories with includeHidden flag', async () => {
    const hiddenDir = `${testDir}/.hidden/foo`;

    // Create hidden directory structure
    await fetch(`${workerUrl}/api/file/mkdir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: `${hiddenDir}/bar`, recursive: true })
    });

    // Write visible files in hidden directory
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: `${hiddenDir}/visible1.txt`,
        content: 'Visible 1'
      })
    });
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: `${hiddenDir}/visible2.txt`,
        content: 'Visible 2'
      })
    });

    // Write hidden file in hidden directory
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: `${hiddenDir}/.hiddenfile.txt`,
        content: 'Hidden'
      })
    });

    // List WITHOUT includeHidden - should NOT show .hiddenfile.txt
    const listResponse = await fetch(`${workerUrl}/api/list-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: hiddenDir })
    });

    expect(listResponse.status).toBe(200);
    const listData = (await listResponse.json()) as ListFilesResult;
    expect(listData.success).toBe(true);

    const visibleFiles = listData.files.filter(
      (f: FileInfo) => !f.name.startsWith('.')
    );
    expect(visibleFiles.length).toBe(3); // visible1.txt, visible2.txt, bar/

    const hiddenFile = listData.files.find(
      (f: FileInfo) => f.name === '.hiddenfile.txt'
    );
    expect(hiddenFile).toBeUndefined();

    // List WITH includeHidden - should show all files
    const listWithHiddenResponse = await fetch(`${workerUrl}/api/list-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: hiddenDir,
        options: { includeHidden: true }
      })
    });

    expect(listWithHiddenResponse.status).toBe(200);
    const listWithHiddenData =
      (await listWithHiddenResponse.json()) as ListFilesResult;

    expect(listWithHiddenData.success).toBe(true);
    expect(listWithHiddenData.files.length).toBe(4); // +.hiddenfile.txt

    const hiddenFileWithFlag = listWithHiddenData.files.find(
      (f: FileInfo) => f.name === '.hiddenfile.txt'
    );
    expect(hiddenFileWithFlag).toBeDefined();
  }, 90000);

  test('should handle rename errors appropriately', async () => {
    const sourcePath = `${testDir}/source.txt`;
    const destPath = `${testDir}/dest.txt`;

    // Try to rename nonexistent file
    const renameResponse = await fetch(`${workerUrl}/api/file/rename`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        oldPath: sourcePath,
        newPath: destPath
      })
    });

    expect(renameResponse.status).toBe(404);
    const errorData = (await renameResponse.json()) as ErrorResponse;
    expect(errorData.error).toBeTruthy();
    expect(errorData.error).toMatch(/not found|does not exist|no such file/i);
  }, 90000);

  test('should handle move errors appropriately', async () => {
    const sourcePath = `${testDir}/source.txt`;
    const destDir = `${testDir}/dest-dir`;

    // Try to move nonexistent file
    const moveResponse = await fetch(`${workerUrl}/api/file/move`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sourcePath: sourcePath,
        destinationPath: `${destDir}/source.txt`
      })
    });

    expect(moveResponse.status).toBe(404);
    const errorData = (await moveResponse.json()) as ErrorResponse;
    expect(errorData.error).toBeTruthy();
    expect(errorData.error).toMatch(/not found|does not exist|no such file/i);
  }, 90000);

  test('should handle binary file reading', async () => {
    const pngPath = `${testDir}/test.png`;

    // Create a minimal valid PNG file (1x1 transparent pixel)
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: pngPath,
        content: pngBase64,
        encoding: 'base64'
      })
    });

    expect(writeResponse.status).toBe(200);

    // Read it back
    const readResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: `${testDir}/test.png` })
    });

    expect(readResponse.status).toBe(200);
    const readData = (await readResponse.json()) as ReadFileResult;

    expect(readData.success).toBe(true);
    expect(readData.encoding).toBe('base64');
    expect(readData.isBinary).toBe(true);
    expect(readData.mimeType).toMatch(/image\/png/);
    expect(readData.content).toBeTruthy();
    expect(readData.size).toBeGreaterThan(0);

    // Verify the content is valid base64
    expect(readData.content).toMatch(/^[A-Za-z0-9+/=]+$/);
  }, 90000);
});

const isCapnweb = process.env.TEST_TRANSPORT === 'rpc';

describe.skipIf(!isCapnweb)('File Streaming Write (capnweb)', () => {
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

  test('should stream-write a file and read it back', async () => {
    const testPath = sandbox!.uniquePath('stream-write.txt');
    const testContent = 'Streamed content for capnweb transport ✨';
    const body = new TextEncoder().encode(testContent);

    const writeResponse = await fetch(`${workerUrl}/api/file/write-stream`, {
      method: 'PUT',
      headers: { ...headers, 'X-File-Path': testPath },
      body
    });
    expect(writeResponse.status).toBe(200);

    const readResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testPath })
    });
    expect(readResponse.status).toBe(200);
    const readResult = (await readResponse.json()) as ReadFileResult;
    expect(readResult.content).toBe(testContent);
  });

  test('should preserve executable permissions on stream-write', async () => {
    const testPath = sandbox!.uniquePath('stream-exec.sh');

    // Create an executable file
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `mkdir -p $(dirname ${testPath}) && printf '#!/bin/sh\necho original' > ${testPath} && chmod +x ${testPath}`
      })
    });

    // Overwrite via streaming
    const newContent = '#!/bin/sh\necho updated';
    const body = new TextEncoder().encode(newContent);
    const writeResponse = await fetch(`${workerUrl}/api/file/write-stream`, {
      method: 'PUT',
      headers: { ...headers, 'X-File-Path': testPath },
      body
    });
    expect(writeResponse.status).toBe(200);

    // Verify file is still executable
    const execResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `test -x ${testPath} && echo executable`
      })
    });
    expect(execResponse.status).toBe(200);
    const result = (await execResponse.json()) as { stdout: string };
    expect(result.stdout.trim()).toBe('executable');
  });

  test('should stream-write a large file', async () => {
    const testPath = sandbox!.uniquePath('stream-large.bin');
    // 256KB of data
    const chunk = new Uint8Array(1024).fill(0x42);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 256; i++) chunks.push(chunk);
    const blob = new Blob(chunks);

    const writeResponse = await fetch(`${workerUrl}/api/file/write-stream`, {
      method: 'PUT',
      headers: { ...headers, 'X-File-Path': testPath },
      body: blob.stream(),
      duplex: 'half'
    } as RequestInit);
    expect(writeResponse.status).toBe(200);

    // Verify size
    const execResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: `stat -c %s ${testPath}` })
    });
    expect(execResponse.status).toBe(200);
    const result = (await execResponse.json()) as { stdout: string };
    expect(Number.parseInt(result.stdout.trim(), 10)).toBe(256 * 1024);
  });
});
