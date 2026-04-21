import type { PortExposeResult, Process } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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

/**
 * Preview URLs survive container restarts.
 *
 * Exposes a port with a custom token, stops the container, restarts the
 * user process inside a fresh container, and fetches the preview URL
 * again. The preview URL responds 200 without the caller re-issuing
 * exposePort() — the SDK re-registers the port with the container on
 * startup using tokens persisted in Durable Object storage.
 */
describe('Preview URL survives container restart', () => {
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
    'preview URL keeps working after the container is stopped and restarted',
    async () => {
      // Bun server that responds with a stable marker on /hello.
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
console.log("Server listening on port " + server.port);
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
        return processId;
      };

      // Phase 1: expose the port with a stable custom token, confirm it works.
      await startServer();
      const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
        method: 'POST',
        headers: portHeaders,
        body: JSON.stringify({
          port: RESTART_TEST_PORT,
          name: 'restart-test',
          token: 'stableafterreboot'
        })
      });
      expect(exposeResponse.status).toBe(200);
      const { url: exposedUrl } =
        (await exposeResponse.json()) as PortExposeResult;

      const before = await fetch(`${exposedUrl}/hello`);
      expect(before.status).toBe(200);
      expect(await before.text()).toBe(`hello from port ${RESTART_TEST_PORT}`);

      // Phase 2: stop the container. DO storage survives.
      const stopResponse = await fetch(`${workerUrl}/api/container/stop`, {
        method: 'POST',
        headers: portHeaders
      });
      expect(stopResponse.status).toBe(200);

      // Phase 3: restart the process inside a fresh container, then hit the
      // preview URL again. The SDK should re-expose the port automatically
      // as part of onStart() and the preview URL should respond without the
      // caller re-issuing exposePort().
      await startServer();

      const after = await fetch(`${exposedUrl}/hello`);
      expect(after.status).toBe(200);
      expect(await after.text()).toBe(`hello from port ${RESTART_TEST_PORT}`);

      // Cleanup
      await fetch(`${workerUrl}/api/exposed-ports/${RESTART_TEST_PORT}`, {
        method: 'DELETE',
        headers: portHeaders
      });
    },
    180000
  );
});
