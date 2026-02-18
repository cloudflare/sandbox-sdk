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
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox,
  uniqueTestPath
} from './helpers/global-sandbox';
import type { ErrorResponse } from './test-worker/types';

describe('File Operations Error Handling', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let testDir: string;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
  }, 120000);

  // Use unique directory for each test to avoid conflicts
  beforeEach(() => {
    testDir = uniqueTestPath('file-ops');
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

    expect(deleteResponse.status).toBe(400);
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
        path: `${testDir}/does-not-exist`
      })
    });

    expect(notFoundResponse.status).toBe(404);
    const notFoundData = (await notFoundResponse.json()) as ErrorResponse;
    expect(notFoundData.error).toBeTruthy();
    expect(notFoundData.error).toMatch(/not found|does not exist/i);

    // Test listing a file instead of directory
    const filePath = `${testDir}/file.txt`;
    await fetch(`${workerUrl}/api/file/mkdir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testDir, recursive: true })
    });
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: filePath,
        content: 'Not a directory'
      })
    });

    const wrongTypeResponse = await fetch(`${workerUrl}/api/list-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: filePath
      })
    });

    expect(wrongTypeResponse.status).toBe(400);
    const wrongTypeData = (await wrongTypeResponse.json()) as ErrorResponse;
    expect(wrongTypeData.error).toMatch(/not a directory/i);
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

  test('should read binary files with base64 encoding', async () => {
    // 1x1 PNG - smallest valid PNG
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jYlkKQAAAABJRU5ErkJggg==';

    // Create binary file via base64 decode
    await fetch(`${workerUrl}/api/file/mkdir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testDir, recursive: true })
    });

    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `echo '${pngBase64}' | base64 -d > ${testDir}/test.png`
      })
    });

    // Read the binary file
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
