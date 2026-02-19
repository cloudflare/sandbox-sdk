/**
 * E2E Test: OpenCode Integration Workflow
 *
 * Tests:
 * - OpenCode CLI availability in the -opencode container variant
 * - Server startup and lifecycle via process API
 */

import type { ExecResult } from '@repo/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox
} from './helpers/global-sandbox';
import { waitForCondition } from './helpers/test-fixtures';

describe('OpenCode Workflow (E2E)', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createOpencodeHeaders(createUniqueSession());
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
      // Cleanup stale OpenCode processes from prior retries/tests.
      const preList = await waitForCondition(
        async () => {
          const response = await fetch(`${workerUrl}/api/process/list`, {
            method: 'GET',
            headers
          });
          if (response.status !== 200) {
            throw new Error(
              `Unexpected process list status: ${response.status}`
            );
          }
          return response;
        },
        {
          timeout: 30000,
          interval: 1000,
          errorMessage: 'Process list endpoint did not become ready'
        }
      );
      const existing = (await preList.json()) as Array<{
        id: string;
        command: string;
      }>;
      await Promise.all(
        existing
          .filter((p) => p.command.includes('opencode serve'))
          .map((p) =>
            fetch(`${workerUrl}/api/process/${p.id}`, {
              method: 'DELETE',
              headers
            })
          )
      );

      // Start OpenCode server as a background process
      const startRes = await waitForCondition(
        async () => {
          const response = await fetch(`${workerUrl}/api/process/start`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              command: 'opencode serve --port 4096 --hostname 0.0.0.0'
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
            port: 4096,
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
        p.command.includes('opencode serve')
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
      expect(killRes.status).toBe(200);
    }, 180000);
  });
});
