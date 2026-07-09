/**
 * E2E Test: OpenCode Integration Workflow
 *
 * Tests:
 * - OpenCode CLI availability in the -opencode container variant
 * - Server startup and lifecycle via process API
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { CommandResponse } from './command-response';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

describe.sequential('OpenCode Workflow (E2E)', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let sandbox: TestSandbox | null = null;

  beforeEach(async () => {
    sandbox = await createTestSandbox({ type: 'opencode' });
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();
  }, 120000);

  afterEach(async () => {
    await cleanupTestSandbox(sandbox);
  }, 120000);

  test('should have opencode CLI available', async () => {
    const res = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'opencode --version']
      })
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as CommandResponse;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+/);
  });

  describe('OpenCode proxy helpers', () => {
    test('should proxy OpenCode global health through the lifecycle handle', async () => {
      const healthUrl = `${workerUrl}/api/opencode/proxy-server/global-health`;

      let res: Response | null = null;
      let lastStatus = 0;
      let lastBody = '';

      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        res = await fetch(healthUrl, {
          method: 'GET',
          headers
        });

        if (res.status === 200) {
          break;
        }

        lastStatus = res.status;
        lastBody = await res.text().catch(() => '');
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      expect(
        res?.status,
        `OpenCode health never returned 200; last status=${lastStatus}, body=${lastBody}`
      ).toBe(200);
      const result = (await res!.json()) as {
        healthy: boolean;
        version: string;
      };
      expect(result.healthy).toBe(true);
      expect(result.version).toMatch(/\d+\.\d+\.\d+/);
    }, 180000);
  });
});
