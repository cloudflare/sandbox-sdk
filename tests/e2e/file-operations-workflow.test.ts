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

import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { ReadFileResult } from '@repo/shared';
import type { ErrorResponse } from './test-worker/types';
import {
  getSharedSandbox,
  createUniqueSession,
  uniqueTestPath
} from './helpers/global-sandbox';

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

    expect(deleteResponse.status).toBe(500);
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

    expect(notFoundResponse.status).toBe(500);
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

    expect(wrongTypeResponse.status).toBe(500);
    const wrongTypeData = (await wrongTypeResponse.json()) as ErrorResponse;
    expect(wrongTypeData.error).toMatch(/not a directory/i);
  }, 90000);
});
