/**
 * E2E Test: OpenCode Integration Workflow
 *
 * Tests:
 * - OpenCode CLI availability in the -opencode container variant
 * - Server startup and lifecycle via process API
 */

import type { ExecResult } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupIsolatedSandbox,
  getIsolatedSandbox,
  type SharedSandbox
} from './helpers/global-sandbox';
import { waitForCondition } from './helpers/test-fixtures';

describe('OpenCode Workflow (E2E)', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let sandbox: SharedSandbox | null = null;

  beforeAll(async () => {
    sandbox = await getIsolatedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createOpencodeHeaders();
  }, 120000);

  afterAll(async () => {
    await cleanupIsolatedSandbox(sandbox);
  }, 120000);

  test('should have opencode CLI available', async () => {
    const res = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'opencode --version' })
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as ExecResult;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+/);
  });

  describe('OpenCode proxy helpers', () => {
    test('should proxy OpenCode global health through proxyToOpencodeServer', async () => {
      const res = await fetch(
        `${workerUrl}/api/opencode/proxy-server/global-health`,
        {
          method: 'GET',
          headers
        }
      );

      expect(res.status).toBe(200);
      const result = (await res.json()) as {
        healthy: boolean;
        version: string;
      };
      expect(result.healthy).toBe(true);
      expect(result.version).toMatch(/\d+\.\d+\.\d+/);
    }, 180000);
  });

  describe('OpenCode server lifecycle', () => {
    test('should start opencode server via process', async () => {
      const testPort = 4400 + Math.floor(Math.random() * 300);

      // Reset process state for this isolated sandbox to avoid stale process IDs
      // from retries interfering with lifecycle assertions.
      const killAllRes = await fetch(`${workerUrl}/api/process/kill-all`, {
        method: 'POST',
        headers
      });
      expect(killAllRes.status).toBe(200);

      // Start OpenCode server as a background process on a unique test port.
      const startRes = await waitForCondition(
        async () => {
          const response = await fetch(`${workerUrl}/api/process/start`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              command: `opencode serve --port ${testPort} --hostname 0.0.0.0`
            })
          });
          if (response.status !== 200) {
            throw new Error(
              `Unexpected process start status: ${response.status}`
            );
          }
          return response;
        },
        {
          timeout: 30000,
          interval: 1000,
          errorMessage: 'Failed to start OpenCode process'
        }
      );
      const startResult = (await startRes.json()) as { id: string };
      expect(startResult.id).toBeDefined();

      // Wait for server to be ready
      const waitRes = await fetch(
        `${workerUrl}/api/process/${startResult.id}/waitForPort`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            port: testPort,
            options: { mode: 'http', path: '/', timeout: 120000 }
          })
        }
      );
      expect(waitRes.status).toBe(200);

      // Verify server is running by listing processes
      const listRes = await fetch(`${workerUrl}/api/process/list`, {
        method: 'GET',
        headers
      });
      expect(listRes.status).toBe(200);
      const processes = (await listRes.json()) as Array<{
        id: string;
        command: string;
        status: string;
      }>;
      const opencodeProcess = processes.find((p) =>
        p.command.includes(`--port ${testPort}`)
      );
      expect(opencodeProcess).toBeDefined();
      expect(opencodeProcess?.status).toBe('running');

      // Kill the server (DELETE method)
      const killRes = await fetch(
        `${workerUrl}/api/process/${startResult.id}`,
        {
          method: 'DELETE',
          headers
        }
      );
      expect([200, 404, 500]).toContain(killRes.status);
    }, 180000);
  });
});
