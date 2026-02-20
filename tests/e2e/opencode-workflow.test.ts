/**
 * E2E Test: OpenCode Integration Workflow
 *
 * Tests:
 * - OpenCode CLI availability in the -opencode container variant
 * - Server startup and lifecycle via process API
 */

import type { ExecResult } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  cleanupIsolatedSandbox,
  getIsolatedSandbox,
  type SharedSandbox
} from './helpers/global-sandbox';

describe.sequential('OpenCode Workflow (E2E)', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let sandbox: SharedSandbox | null = null;

  beforeEach(async () => {
    sandbox = await getIsolatedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createOpencodeHeaders();
  }, 120000);

  afterEach(async () => {
    await cleanupIsolatedSandbox(sandbox);
    sandbox = null;
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
      const testPort = 4096;

      const startRes = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `opencode serve --port ${testPort} --hostname 0.0.0.0`
        })
      });

      if (startRes.status !== 200) {
        const body = await startRes.text().catch(() => '(unreadable response)');
        throw new Error(
          `Failed to start OpenCode process. status=${startRes.status}, body=${body}`
        );
      }

      const startResult = (await startRes.json()) as { id: string };
      expect(startResult.id).toBeDefined();

      const processId = startResult.id;

      try {
        const waitRes = await fetch(
          `${workerUrl}/api/process/${processId}/waitForPort`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              port: testPort,
              options: {
                mode: 'http',
                path: '/global/health',
                status: 200,
                timeout: 180000,
                interval: 1000
              }
            })
          }
        );

        if (waitRes.status !== 200) {
          const [waitErrorBody, processListRes, processLogsRes] =
            await Promise.all([
              waitRes.text().catch(() => '(unreadable response body)'),
              fetch(`${workerUrl}/api/process/list`, {
                method: 'GET',
                headers
              }),
              fetch(`${workerUrl}/api/process/${processId}/logs`, {
                method: 'GET',
                headers
              })
            ]);

          const processListBody = await processListRes
            .text()
            .catch(() => '(unreadable process list)');
          const processLogsBody = await processLogsRes
            .text()
            .catch(() => '(unreadable process logs)');

          throw new Error(
            `waitForPort failed with status ${waitRes.status}. ` +
              `wait body: ${waitErrorBody}. ` +
              `process list status/body: ${processListRes.status}/${processListBody}. ` +
              `process logs status/body: ${processLogsRes.status}/${processLogsBody}`
          );
        }

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
        const opencodeProcess = processes.find((p) => p.id === processId);
        expect(opencodeProcess).toBeDefined();
        expect(opencodeProcess?.status).toBe('running');
      } finally {
        const killRes = await fetch(`${workerUrl}/api/process/${processId}`, {
          method: 'DELETE',
          headers
        });

        // Process might already be gone if it crashed after readiness.
        expect([200, 404]).toContain(killRes.status);
      }
    }, 240000);
  });
});
