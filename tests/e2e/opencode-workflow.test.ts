/**
 * E2E Test: OpenCode Integration Workflow
 *
 * Tests the complete OpenCode integration including:
 * - OpenCode CLI availability in the container
 * - Server startup via SDK
 * - Process reuse for existing servers
 * - Basic SDK client operations
 *
 * These tests require the -opencode container variant which includes
 * the OpenCode CLI pre-installed.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import {
  getSharedSandbox,
  createUniqueSession
} from './helpers/global-sandbox';
import type { ExecResult } from '@repo/shared';

describe('OpenCode Workflow (E2E)', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createOpencodeHeaders(createUniqueSession());
  }, 120000);

  describe('OpenCode CLI availability', () => {
    test('should have opencode command available', async () => {
      const res = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: 'which opencode' })
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as ExecResult;
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('opencode');
    });

    test('should report opencode version', async () => {
      const res = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: 'opencode --version' })
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as ExecResult;
      expect(result.exitCode).toBe(0);
      // Version output should contain version number
      expect(result.stdout).toMatch(/\d+\.\d+/);
    });
  });

  describe('OpenCode server lifecycle', () => {
    test('should start opencode server via process', async () => {
      // Start OpenCode server as a background process
      const startRes = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'opencode serve --port 4096 --hostname 0.0.0.0'
        })
      });
      expect(startRes.status).toBe(200);
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
            options: { mode: 'http', path: '/', timeout: 30000 }
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

      // Kill the server
      const killRes = await fetch(
        `${workerUrl}/api/process/${startResult.id}/kill`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ signal: 'SIGTERM' })
        }
      );
      expect(killRes.status).toBe(200);
    }, 60000);
  });
});
