import type { PortExposeResult, Process } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupIsolatedSandbox,
  createUniqueSession,
  getIsolatedSandbox,
  type SharedSandbox
} from './helpers/global-sandbox';

// Port exposure tests require custom domain with wildcard DNS routing
const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

const REDIRECT_TEST_PORT = 9850;

/**
 * Redirect Proxy Workflow Tests
 *
 * Verifies that proxyToSandbox() forwards redirect responses (3xx) back to the
 * caller as-is, rather than automatically following them.
 */
describe('Redirect Proxy Workflow', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let portHeaders: Record<string, string>;
  let sandbox: SharedSandbox | null = null;

  beforeAll(async () => {
    sandbox = await getIsolatedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
    portHeaders = {
      'X-Sandbox-Id': sandbox.sandboxId,
      'Content-Type': 'application/json'
    };
  }, 120000);

  afterAll(async () => {
    await cleanupIsolatedSandbox(sandbox);
  }, 120000);

  test.skipIf(skipPortExposureTests)(
    'should pass 307 redirect through to the caller without following it',
    async () => {
      // A minimal Bun server that always replies with a 307 + Set-Cookie headers
      const serverCode = `
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: ${REDIRECT_TEST_PORT},
  fetch(req) {
    return new Response(null, {
      status: 307,
      headers: [
        ["Location", "/dashboard"],
        ["Set-Cookie", "session=abc123; Path=/; HttpOnly"],
        ["Set-Cookie", "theme=dark; Path=/"],
      ],
    });
  },
});
console.log("Redirect server listening on port " + server.port);
await Bun.sleep(60000);
      `.trim();

      // Write the server script into the container
      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/redirect-server.ts',
          content: serverCode
        })
      });

      // Start the server process
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `bun run /workspace/redirect-server.ts`
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
            port: REDIRECT_TEST_PORT,
            timeout: 15000,
            mode: 'tcp'
          })
        }
      );
      expect(waitPortResponse.status).toBe(200);

      // Expose the port so we get a preview URL
      const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
        method: 'POST',
        headers: portHeaders,
        body: JSON.stringify({
          port: REDIRECT_TEST_PORT,
          name: 'redirect-test'
        })
      });
      expect(exposeResponse.status).toBe(200);
      const { url: exposedUrl } =
        (await exposeResponse.json()) as PortExposeResult;

      // Fetch the exposed URL
      const proxyResponse = await fetch(exposedUrl, { redirect: 'manual' });

      // The proxy should return the 307
      expect(proxyResponse.status).toBe(307);
      expect(proxyResponse.headers.get('Location')).toBe('/dashboard');

      // Both Set-Cookie headers must be forwarded to the caller
      const setCookieValues = proxyResponse.headers.getSetCookie();
      expect(setCookieValues).toContain('session=abc123; Path=/; HttpOnly');
      expect(setCookieValues).toContain('theme=dark; Path=/');

      // Cleanup
      await fetch(`${workerUrl}/api/exposed-ports/${REDIRECT_TEST_PORT}`, {
        method: 'DELETE',
        headers: portHeaders
      });
      await fetch(`${workerUrl}/api/process/${processId}`, {
        method: 'DELETE',
        headers
      });
    },
    90000
  );
});
