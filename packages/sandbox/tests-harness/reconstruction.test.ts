import { execFileSync } from 'node:child_process';
import type { DurableObjectNamespace as WorkersDurableObjectNamespace } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';

const dockerAvailable = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const skipHarness = process.platform !== 'linux' && process.env.CI === 'true';
const skipWithoutDocker = process.env.CI !== 'true' && !dockerAvailable;

describe.skipIf(skipHarness || skipWithoutDocker)(
  'Sandbox DO eviction and Worker reload characterization',
  () => {
    let server: TestHarness;

    beforeEach(async () => {
      server = createTestHarness({
        root: import.meta.dirname,
        workers: [{ configPath: './wrangler.jsonc' }]
      });
      await server.listen();
    });

    afterEach(async () => {
      await server?.close();
    });

    it('applies dynamic environment to a fresh container process', async () => {
      const sandboxId = crypto.randomUUID();
      const configured = await server.fetch(
        `/configure?sandboxId=${sandboxId}`,
        { method: 'POST' }
      );
      expect(configured.status).toBe(200);

      const execution = await server.fetch(`/snapshot?sandboxId=${sandboxId}`);
      expect(execution.status).toBe(200);
      expect(await execution.json()).toMatchObject({
        exitCode: 0,
        stderr: '',
        stdout: 'configured',
        timedOut: false,
        truncated: false
      });
    });

    it('contrasts durable and in-memory state after DO eviction', async () => {
      const sandboxId = crypto.randomUUID();
      const configured = await server.fetch(
        `/configure?sandboxId=${sandboxId}`,
        { method: 'POST' }
      );
      expect(configured.status).toBe(200);
      expect(await configured.json()).toMatchObject({
        envVars: { HARNESS_MARKER: 'configured' },
        sleepAfter: '30m'
      });

      await server
        .getWorker<{ Sandbox: WorkersDurableObjectNamespace }>()
        .evictDurableObject('Sandbox', { name: sandboxId });

      const response = await server.fetch(`/state?sandboxId=${sandboxId}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        envVars: {},
        sleepAfter: '30m'
      });

      // Starting the target container before eviction would leave active local
      // references that Miniflare cannot evict. The preceding test is the
      // positive control for the same setEnvVars-to-exec path.
      const execution = await server.fetch(`/snapshot?sandboxId=${sandboxId}`);
      expect(execution.status).toBe(200);
      expect(await execution.json()).toMatchObject({
        exitCode: 0,
        stderr: '',
        stdout: '',
        timedOut: false,
        truncated: false
      });
    });

    it('clears in-memory DO state after a coordinated Worker reload', async () => {
      const sandboxId = crypto.randomUUID();
      const configured = await server.fetch(
        `/configure?sandboxId=${sandboxId}`,
        { method: 'POST' }
      );
      expect(configured.status).toBe(200);

      await server.update((options) => ({
        ...options,
        workers: options.workers.map((worker) =>
          'configPath' in worker
            ? {
                ...worker,
                vars: { ...worker.vars, HARNESS_RELOAD: 'after' }
              }
            : worker
        )
      }));

      const response = await server.fetch(`/state?sandboxId=${sandboxId}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ envVars: {} });

      const execution = await server.fetch(`/snapshot?sandboxId=${sandboxId}`);
      const executionBody = await execution.json();
      expect(execution.status, JSON.stringify(executionBody, null, 2)).toBe(
        200
      );
      expect(executionBody).toMatchObject({
        exitCode: 0,
        stderr: '',
        stdout: '',
        timedOut: false,
        truncated: false
      });
    });
  }
);
