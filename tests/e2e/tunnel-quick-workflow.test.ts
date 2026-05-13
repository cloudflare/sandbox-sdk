import type { Process } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

/**
 * Quick tunnel round-trip.
 *
 * Spawns a tiny Bun HTTP server inside the sandbox, calls
 * `sandbox.tunnels.create(port)`, then `fetch()`s the returned
 * `*.trycloudflare.com` URL from outside the container and asserts the
 * body matches.
 *
 * Quick tunnels need no Cloudflare credentials, so this is the cheapest
 * end-to-end check that the cloudflared binary, the TunnelManager
 * spawn/ready logic, and the RPC plumbing all work.
 *
 * Skipped unless `TEST_TRANSPORT=rpc` — the route-based transport's
 * `tunnels` stub is intentionally a "not implemented" placeholder.
 */

const TUNNEL_TEST_PORT = 9871;

const skipQuickTunnel = (process.env.TEST_TRANSPORT ?? 'http') !== 'rpc';

interface QuickTunnelInfo {
  id: string;
  port: number;
  url: string;
  hostname: string;
  createdAt: string;
  name?: never;
}

describe('Quick tunnel round-trip', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let sandbox: TestSandbox | null = null;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();
  }, 120_000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
  }, 120_000);

  test.skipIf(skipQuickTunnel)(
    'creates a *.trycloudflare.com URL that proxies to a server inside the sandbox',
    async () => {
      // 1. Boot a Bun server inside the sandbox.
      const marker = `quick-tunnel-${Math.random().toString(36).slice(2, 10)}`;
      const serverCode = `
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: ${TUNNEL_TEST_PORT},
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/marker") {
      return new Response("${marker}", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log("Server listening on port " + server.port);
      `.trim();

      const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/quick-tunnel-server.ts',
          content: serverCode
        })
      });
      expect(writeResponse.status).toBe(200);

      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'bun run /workspace/quick-tunnel-server.ts'
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
            port: TUNNEL_TEST_PORT,
            timeout: 15_000,
            mode: 'tcp'
          })
        }
      );
      expect(waitPortResponse.status).toBe(200);

      // 2. Create the quick tunnel.
      const createResponse = await fetch(`${workerUrl}/api/tunnel/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ port: TUNNEL_TEST_PORT })
      });
      expect(createResponse.status).toBe(200);
      const tunnel = (await createResponse.json()) as QuickTunnelInfo;
      expect(tunnel.name).toBeUndefined();
      expect(tunnel.port).toBe(TUNNEL_TEST_PORT);
      expect(tunnel.url).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
      expect(tunnel.hostname).toMatch(/\.trycloudflare\.com$/);
      expect(tunnel.id).toMatch(/^quick-[0-9a-f]{16}$/);

      try {
        // 3. Confirm list() round-trips the tunnel.
        const listResponse = await fetch(`${workerUrl}/api/tunnel/list`, {
          headers
        });
        expect(listResponse.status).toBe(200);
        const { tunnels } = (await listResponse.json()) as {
          tunnels: QuickTunnelInfo[];
        };
        expect(tunnels.map((t) => t.id)).toContain(tunnel.id);

        // 4. Fetch the marker from the public URL. The Cloudflare edge can
        //    take a couple of seconds to fully propagate even after
        //    cloudflared reports `/ready`, so retry briefly.
        const fetchedBody = await fetchWithRetry(
          `${tunnel.url}/marker`,
          marker,
          { tries: 10, delayMs: 1000 }
        );
        expect(fetchedBody).toBe(marker);
      } finally {
        // 5. Clean up — the tunnel and the user process.
        await fetch(
          `${workerUrl}/api/tunnel/${encodeURIComponent(tunnel.id)}`,
          { method: 'DELETE', headers }
        );
        await fetch(`${workerUrl}/api/process/${processId}/kill`, {
          method: 'POST',
          headers
        }).catch(() => {});
      }

      // 6. After destroy, the tunnel is no longer in list().
      const listAfter = await fetch(`${workerUrl}/api/tunnel/list`, {
        headers
      });
      const { tunnels: tunnelsAfter } = (await listAfter.json()) as {
        tunnels: QuickTunnelInfo[];
      };
      expect(tunnelsAfter.map((t) => t.id)).not.toContain(tunnel.id);
    },
    180_000
  );

  test.skipIf(skipQuickTunnel)(
    'runs two tunnels on two different ports side by side',
    async () => {
      const portA = TUNNEL_TEST_PORT + 1;
      const portB = TUNNEL_TEST_PORT + 2;
      const markerA = `multi-a-${Math.random().toString(36).slice(2, 8)}`;
      const markerB = `multi-b-${Math.random().toString(36).slice(2, 8)}`;

      const startServer = async (port: number, marker: string) => {
        const code = `
Bun.serve({
  hostname: "0.0.0.0",
  port: ${port},
  fetch() { return new Response("${marker}"); }
});
        `.trim();
        const filePath = `/workspace/multi-tunnel-${port}.ts`;
        await fetch(`${workerUrl}/api/file/write`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ path: filePath, content: code })
        });
        const start = await fetch(`${workerUrl}/api/process/start`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ command: `bun run ${filePath}` })
        });
        const { id: processId } = (await start.json()) as Process;
        await fetch(
          `${workerUrl}/api/process/${processId}/waitForPort`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ port, timeout: 15_000, mode: 'tcp' })
          }
        );
        return processId;
      };

      const createTunnel = async (port: number) => {
        const r = await fetch(`${workerUrl}/api/tunnel/create`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ port })
        });
        expect(r.status).toBe(200);
        return (await r.json()) as QuickTunnelInfo;
      };

      const processA = await startServer(portA, markerA);
      const processB = await startServer(portB, markerB);
      const tunnelA = await createTunnel(portA);
      const tunnelB = await createTunnel(portB);

      try {
        expect(tunnelA.id).not.toBe(tunnelB.id);
        expect(tunnelA.url).not.toBe(tunnelB.url);
        expect(tunnelA.port).toBe(portA);
        expect(tunnelB.port).toBe(portB);

        const listResponse = await fetch(`${workerUrl}/api/tunnel/list`, {
          headers
        });
        const { tunnels } = (await listResponse.json()) as {
          tunnels: QuickTunnelInfo[];
        };
        const ids = tunnels.map((t) => t.id);
        expect(ids).toContain(tunnelA.id);
        expect(ids).toContain(tunnelB.id);

        // Each tunnel routes to its own backing port.
        const [bodyA, bodyB] = await Promise.all([
          fetchWithRetry(tunnelA.url, markerA, { tries: 10, delayMs: 1000 }),
          fetchWithRetry(tunnelB.url, markerB, { tries: 10, delayMs: 1000 })
        ]);
        expect(bodyA).toBe(markerA);
        expect(bodyB).toBe(markerB);
      } finally {
        await Promise.all([
          fetch(
            `${workerUrl}/api/tunnel/${encodeURIComponent(tunnelA.id)}`,
            { method: 'DELETE', headers }
          ),
          fetch(
            `${workerUrl}/api/tunnel/${encodeURIComponent(tunnelB.id)}`,
            { method: 'DELETE', headers }
          )
        ]);
        await Promise.all([
          fetch(`${workerUrl}/api/process/${processA}/kill`, {
            method: 'POST',
            headers
          }).catch(() => {}),
          fetch(`${workerUrl}/api/process/${processB}/kill`, {
            method: 'POST',
            headers
          }).catch(() => {})
        ]);
      }
    },
    240_000
  );
});

async function fetchWithRetry(
  url: string,
  expectedBody: string,
  opts: { tries: number; delayMs: number }
): Promise<string> {
  let lastError: unknown;
  for (let i = 0; i < opts.tries; i++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000)
      });
      if (response.ok) {
        const body = await response.text();
        if (body === expectedBody) return body;
        lastError = new Error(
          `Unexpected body (status ${response.status}): ${body.slice(0, 80)}`
        );
      } else {
        lastError = new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, opts.delayMs));
  }
  throw new Error(
    `fetchWithRetry failed for ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
