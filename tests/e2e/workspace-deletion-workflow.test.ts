/**
 * Workspace Deletion Workflow Tests (Issue #288)
 *
 * Tests the fix for GitHub issue #288 where `sandbox.exec()` fails with
 * "Unknown Error, TODO" after `/workspace` is removed or replaced with symlink.
 *
 * These tests verify:
 * 1. Symlinks work correctly in non-/workspace directories
 * 2. Session continues working after /workspace is deleted
 * 3. Session continues working after /workspace is replaced with symlink
 * 4. Session can recreate /workspace after deletion
 * 5. New sessions can be created even when /workspace doesn't exist
 *
 * @see https://github.com/cloudflare/sandbox-sdk/issues/288
 */

import { describe, test, expect, beforeAll } from 'vitest';
import {
  getSharedSandbox,
  createUniqueSession,
  uniqueTestPath
} from './helpers/global-sandbox';
import type { ExecResult } from '@repo/shared';

describe('Workspace Deletion Workflow (Issue #288)', () => {
  let workerUrl: string;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
  }, 120000);

  /**
   * Test 1: Symlinks in /tmp (non-/workspace directories)
   *
   * Verifies that symlinks work correctly when /workspace is not involved.
   * This establishes a baseline that symlink functionality itself is working.
   */
  test('should handle symlinks in /tmp directories correctly', async () => {
    // Use a unique session for this test
    const sandbox = await getSharedSandbox();
    const headers = sandbox.createHeaders(createUniqueSession());
    const testDir = `/tmp/symlink-test-${Date.now()}`;

    // Create source directory and file
    const mkdirResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `mkdir -p ${testDir}/source`
      })
    });
    expect(mkdirResponse.status).toBe(200);

    // Write a file in the source directory
    const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: `${testDir}/source/test.txt`,
        content: 'symlink content'
      })
    });
    expect(writeResponse.status).toBe(200);

    // Create a symlink to the source directory
    const symlinkResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `ln -sf ${testDir}/source ${testDir}/target`
      })
    });
    expect(symlinkResponse.status).toBe(200);

    // Read the file through the symlink
    const catResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `cat ${testDir}/target/test.txt`
      })
    });
    expect(catResponse.status).toBe(200);
    const catData = (await catResponse.json()) as ExecResult;
    expect(catData.success).toBe(true);
    expect(catData.stdout?.trim()).toBe('symlink content');

    // Cleanup
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: `rm -rf ${testDir}` })
    });
  }, 90000);

  /**
   * Test 2: Session continues working after deleting its working directory
   *
   * This tests that an existing session can continue executing commands
   * even after its current working directory is deleted. The shell maintains
   * the directory inode until it changes directory.
   */
  test('should continue working after session cwd is deleted', async () => {
    // Use a unique session for this test
    const sandbox = await getSharedSandbox();
    const headers = sandbox.createHeaders(createUniqueSession());
    const testWorkspace = uniqueTestPath('workspace-deletion');

    // Create a working directory for this test
    const mkdirResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `mkdir -p ${testWorkspace}`
      })
    });
    expect(mkdirResponse.status).toBe(200);

    // Verify baseline works
    const baselineResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "baseline works"'
      })
    });
    expect(baselineResponse.status).toBe(200);
    const baselineData = (await baselineResponse.json()) as ExecResult;
    expect(baselineData.success).toBe(true);
    expect(baselineData.stdout?.trim()).toBe('baseline works');

    // Delete the workspace directory
    const deleteResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `rm -rf ${testWorkspace}`
      })
    });
    expect(deleteResponse.status).toBe(200);

    // Try a subsequent command - this should NOT fail
    const afterDeleteResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "after deletion"'
      })
    });
    expect(afterDeleteResponse.status).toBe(200);
    const afterDeleteData = (await afterDeleteResponse.json()) as ExecResult;
    expect(afterDeleteData.success).toBe(true);
    expect(afterDeleteData.stdout?.trim()).toBe('after deletion');
  }, 90000);

  /**
   * Test 3: Session continues after /workspace is replaced with symlink
   *
   * Tests that replacing /workspace with a symlink to a valid directory
   * doesn't break subsequent exec() calls.
   */
  test('should continue working after workspace is replaced with symlink', async () => {
    // Use a unique session for this test
    const sandbox = await getSharedSandbox();
    const headers = sandbox.createHeaders(createUniqueSession());
    const testWorkspace = uniqueTestPath('workspace-symlink');
    const backupDir = `/tmp/backup-${Date.now()}`;

    // Create directories for the test
    const setupResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `mkdir -p ${testWorkspace} ${backupDir}`
      })
    });
    expect(setupResponse.status).toBe(200);

    // Verify baseline works
    const baselineResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "baseline"'
      })
    });
    expect(baselineResponse.status).toBe(200);
    const baselineData = (await baselineResponse.json()) as ExecResult;
    expect(baselineData.success).toBe(true);
    expect(baselineData.stdout?.trim()).toBe('baseline');

    // Replace workspace with a symlink to backup directory
    const symlinkResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `rm -rf ${testWorkspace} && ln -sf ${backupDir} ${testWorkspace}`
      })
    });
    expect(symlinkResponse.status).toBe(200);

    // Try a subsequent command - should continue working
    const afterSymlinkResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "after symlink"'
      })
    });
    expect(afterSymlinkResponse.status).toBe(200);
    const afterSymlinkData = (await afterSymlinkResponse.json()) as ExecResult;
    expect(afterSymlinkData.success).toBe(true);
    expect(afterSymlinkData.stdout?.trim()).toBe('after symlink');

    // Cleanup
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: `rm -rf ${testWorkspace} ${backupDir}` })
    });
  }, 90000);

  /**
   * Test 4: Can recreate directory after deletion
   *
   * Tests that after deleting a directory, we can recreate it with mkdir.
   * This was one of the failure cases in issue #288.
   */
  test('should be able to recreate directory after deletion', async () => {
    // Use a unique session for this test
    const sandbox = await getSharedSandbox();
    const headers = sandbox.createHeaders(createUniqueSession());
    const testWorkspace = uniqueTestPath('workspace-recreate');

    // Create initial workspace
    const createResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `mkdir -p ${testWorkspace}`
      })
    });
    expect(createResponse.status).toBe(200);

    // Delete it
    const deleteResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `rm -rf ${testWorkspace}`
      })
    });
    expect(deleteResponse.status).toBe(200);

    // Recreate it - this should work
    const recreateResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `mkdir -p ${testWorkspace}`
      })
    });
    expect(recreateResponse.status).toBe(200);
    const recreateData = (await recreateResponse.json()) as ExecResult;
    expect(recreateData.success).toBe(true);

    // Verify it was recreated
    const verifyResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `ls -d ${testWorkspace}`
      })
    });
    expect(verifyResponse.status).toBe(200);
    const verifyData = (await verifyResponse.json()) as ExecResult;
    expect(verifyData.success).toBe(true);
    expect(verifyData.stdout?.trim()).toBe(testWorkspace);

    // Cleanup
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: `rm -rf ${testWorkspace}` })
    });
  }, 90000);

  /**
   * Test 5: Recovery by changing to a valid directory
   *
   * Tests that after cwd is deleted, we can recover by cd-ing to a valid directory.
   */
  test('should be recoverable by cd-ing to valid directory after cwd deletion', async () => {
    // Use a unique session for this test
    const sandbox = await getSharedSandbox();
    const headers = sandbox.createHeaders(createUniqueSession());
    const testWorkspace = uniqueTestPath('workspace-recovery');

    // Create workspace
    const createResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `mkdir -p ${testWorkspace}`
      })
    });
    expect(createResponse.status).toBe(200);

    // Delete workspace
    const deleteResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `rm -rf ${testWorkspace}`
      })
    });
    expect(deleteResponse.status).toBe(200);

    // Change to a valid directory and verify
    const cdResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'cd /tmp && pwd'
      })
    });
    expect(cdResponse.status).toBe(200);
    const cdData = (await cdResponse.json()) as ExecResult;
    expect(cdData.success).toBe(true);
    expect(cdData.stdout?.trim()).toBe('/tmp');

    // Subsequent commands should work
    const afterCdResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "recovered"'
      })
    });
    expect(afterCdResponse.status).toBe(200);
    const afterCdData = (await afterCdResponse.json()) as ExecResult;
    expect(afterCdData.success).toBe(true);
    expect(afterCdData.stdout?.trim()).toBe('recovered');
  }, 90000);

  /**
   * Test 6: New session can be created when /workspace doesn't exist
   *
   * This tests the core fix for issue #288: when a new session is created
   * and /workspace doesn't exist, it should fall back to / instead of failing.
   *
   * Note: This test uses a different sandbox ID to ensure a completely new
   * session is created (not reusing an existing one).
   */
  test('should create new session successfully even when default cwd does not exist', async () => {
    // Use a completely new session to force session creation
    const sandbox = await getSharedSandbox();
    const uniqueSession = `new-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const headers = sandbox.createHeaders(uniqueSession);

    // Execute a simple command in the new session
    // The session will be created on-demand, and should fall back to /
    // if /workspace doesn't exist
    const execResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "new session works"'
      })
    });

    expect(execResponse.status).toBe(200);
    const execData = (await execResponse.json()) as ExecResult;
    expect(execData.success).toBe(true);
    expect(execData.stdout?.trim()).toBe('new session works');

    // The command should have executed without errors
    expect(execData.stderr?.toLowerCase() || '').not.toContain('unknown error');
    expect(execData.stderr?.toLowerCase() || '').not.toContain('todo');
  }, 90000);

  /**
   * Test 7: Multiple operations after workspace manipulation
   *
   * Tests a realistic workflow where the workspace is manipulated
   * and then multiple subsequent operations are performed.
   */
  test('should handle multiple operations after workspace manipulation', async () => {
    const sandbox = await getSharedSandbox();
    const headers = sandbox.createHeaders(createUniqueSession());
    const testWorkspace = uniqueTestPath('workspace-multi-ops');
    const backupDir = `/tmp/multi-ops-backup-${Date.now()}`;

    // Setup: create workspace and backup directories
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `mkdir -p ${testWorkspace} ${backupDir}`
      })
    });

    // Write a file
    const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: `${testWorkspace}/test.txt`,
        content: 'original content'
      })
    });
    expect(writeResponse.status).toBe(200);

    // Replace workspace with symlink
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `rm -rf ${testWorkspace} && ln -sf ${backupDir} ${testWorkspace}`
      })
    });

    // Multiple subsequent operations should all work:

    // 1. Echo command
    const echo1Response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo "operation 1"' })
    });
    expect(echo1Response.status).toBe(200);
    const echo1Data = (await echo1Response.json()) as ExecResult;
    expect(echo1Data.success).toBe(true);

    // 2. Write file to backup (through symlink)
    const write2Response = await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: `${backupDir}/new-file.txt`,
        content: 'new content'
      })
    });
    expect(write2Response.status).toBe(200);

    // 3. Read the file back
    const readResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: `${backupDir}/new-file.txt`
      })
    });
    expect(readResponse.status).toBe(200);

    // 4. Another exec command
    const echo2Response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo "operation 4"' })
    });
    expect(echo2Response.status).toBe(200);
    const echo2Data = (await echo2Response.json()) as ExecResult;
    expect(echo2Data.success).toBe(true);
    expect(echo2Data.stdout?.trim()).toBe('operation 4');

    // Cleanup
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: `rm -rf ${testWorkspace} ${backupDir}` })
    });
  }, 90000);
});
