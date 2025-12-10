/**
 * Workspace Deletion Workflow Tests (Issue #288)
 *
 * Tests that new sessions fall back to the home directory when /workspace
 * doesn't exist, preventing "Unknown Error, TODO" failures.
 *
 * @see https://github.com/cloudflare/sandbox-sdk/issues/288
 */

import { describe, test, expect, beforeAll } from 'vitest';
import {
  getSharedSandbox,
  createUniqueSession
} from './helpers/global-sandbox';
import type { ExecResult } from '@repo/shared';

describe('Workspace Deletion Workflow (Issue #288)', () => {
  let workerUrl: string;
  let sandbox: Awaited<ReturnType<typeof getSharedSandbox>>;

  beforeAll(async () => {
    sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
  }, 120000);

  /**
   * Core test for issue #288: new session creation after /workspace is deleted.
   *
   * The bug was that creating a NEW session after /workspace was deleted would
   * fail with "Unknown Error, TODO". The fix makes session initialization fall
   * back to the home directory if /workspace doesn't exist.
   */
  test('new session falls back to home directory when /workspace is deleted', async () => {
    const setupHeaders = sandbox.createHeaders(createUniqueSession());

    // Delete /workspace
    const deleteResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: setupHeaders,
      body: JSON.stringify({ command: 'rm -rf /workspace' })
    });
    expect(deleteResponse.status).toBe(200);

    // Create a NEW session - this is where the bug occurred
    const newHeaders = sandbox.createHeaders(createUniqueSession());

    const execResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: newHeaders,
      body: JSON.stringify({ command: 'pwd' })
    });

    expect(execResponse.status).toBe(200);
    const execData = (await execResponse.json()) as ExecResult;
    expect(execData.success).toBe(true);
    expect(execData.stdout?.trim()).toBe('/root');

    // Restore /workspace for other tests
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: setupHeaders,
      body: JSON.stringify({ command: 'mkdir -p /workspace' })
    });
  }, 90000);

  /**
   * Tests that new sessions work when /workspace is a symlink to a valid directory.
   */
  test('new session works when /workspace is a symlink', async () => {
    const setupHeaders = sandbox.createHeaders(createUniqueSession());
    const backupDir = `/tmp/workspace-backup-${Date.now()}`;

    // Replace /workspace with a symlink
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: setupHeaders,
      body: JSON.stringify({
        command: `mkdir -p ${backupDir} && rm -rf /workspace && ln -sf ${backupDir} /workspace`
      })
    });

    // Create a NEW session - should work with the symlink
    const newHeaders = sandbox.createHeaders(createUniqueSession());

    const execResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: newHeaders,
      body: JSON.stringify({ command: 'pwd -P' }) // -P resolves symlinks
    });

    expect(execResponse.status).toBe(200);
    const execData = (await execResponse.json()) as ExecResult;
    expect(execData.success).toBe(true);
    expect(execData.stdout?.trim()).toBe(backupDir);

    // Restore /workspace as a real directory
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: setupHeaders,
      body: JSON.stringify({
        command: `rm -f /workspace && mkdir -p /workspace && rm -rf ${backupDir}`
      })
    });
  }, 90000);
});
