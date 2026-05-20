import type { PortExposeResult, Process } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { stopContainerAndWait } from './helpers/container-lifecycle';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';

// Port exposure tests require custom domain with wildcard DNS routing
const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

const RESTART_TEST_PORT = 9851;

function previewURL(previewUrl: string, path: string): string {
  return new URL(path, previewUrl).toString();
}

/**
 * Preview URL authorization survives container restarts, but activation is
 * scoped to the runtime where exposePort() was last called.
 */
describe('Preview URL runtime activation after container restart', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let portHeaders: Record<string, string>;
  let sandbox: TestSandbox | null = null;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers(createUniqueSession());
    portHeaders = {
      'X-Sandbox-Id': sandbox.sandboxId,
      'Content-Type': 'application/json'
    };
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
  }, 120000);

  test.skipIf(skipPortExposureTests)(
    'preview URL stays stale after restart until the port is exposed again',
    async () => {
      const serverCode = `
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: ${RESTART_TEST_PORT},
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/hello") {
      return new Response("hello from port ${RESTART_TEST_PORT}", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
});
await Bun.sleep(300000);
      `.trim();

      const startServer = async () => {
        await fetch(`${workerUrl}/api/file/write`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            path: '/workspace/restart-server.ts',
            content: serverCode
          })
        });
        const startResponse = await fetch(`${workerUrl}/api/process/start`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: `bun run /workspace/restart-server.ts`
          })
        });
        expect(startResponse.status).toBe(200);
        const { id: processId } = (await startResponse.json()) as Process;
        const waitPortResponse = await fetch(
          `${workerUrl}/api/process/${processId}/waitForPort`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              port: RESTART_TEST_PORT,
              timeout: 15000,
              mode: 'tcp'
            })
          }
        );
        expect(waitPortResponse.status).toBe(200);
      };

      await startServer();
      const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
        method: 'POST',
        headers: portHeaders,
        body: JSON.stringify({
          port: RESTART_TEST_PORT,
          name: 'restart-test',
          token: 'stable_reboot'
        })
      });
      expect(exposeResponse.status).toBe(200);
      const { url: exposedUrl } =
        (await exposeResponse.json()) as PortExposeResult;

      const before = await fetch(previewURL(exposedUrl, '/hello'));
      expect(before.status).toBe(200);
      expect(await before.text()).toBe(`hello from port ${RESTART_TEST_PORT}`);

      await stopContainerAndWait(workerUrl, portHeaders);

      await startServer();

      const stale = await fetch(previewURL(exposedUrl, '/hello'));
      expect(stale.status).toBe(410);
      expect(await stale.json()).toMatchObject({ code: 'STALE_PREVIEW_URL' });

      const reactivateResponse = await fetch(`${workerUrl}/api/port/expose`, {
        method: 'POST',
        headers: portHeaders,
        body: JSON.stringify({
          port: RESTART_TEST_PORT,
          name: 'restart-test'
        })
      });
      expect(reactivateResponse.status).toBe(200);
      const { url: reactivatedUrl } =
        (await reactivateResponse.json()) as PortExposeResult;
      expect(reactivatedUrl).toBe(exposedUrl);

      const after = await fetch(previewURL(exposedUrl, '/hello'));
      expect(after.status).toBe(200);
      expect(await after.text()).toBe(`hello from port ${RESTART_TEST_PORT}`);

      await fetch(`${workerUrl}/api/exposed-ports/${RESTART_TEST_PORT}`, {
        method: 'DELETE',
        headers: portHeaders
      });
    },
    180000
  );
});
