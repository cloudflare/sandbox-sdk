import type { Process } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

/**
 * Named-tunnel round-trip against a real Cloudflare zone.
 *
 * Provisions `<name>.<zone>` via `sandbox.tunnels.get(port, { name })`,
 * confirms the public hostname proxies into the container, then tears
 * everything down via `destroy()` and verifies the Cloudflare API no
 * longer holds the resources.
 *
 * Skipped unless:
 *   - `TEST_TRANSPORT=rpc` (route-based transport doesn't expose
 *     `sandbox.tunnels`), and
 *   - `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID` are set, and
 *   - `CLOUDFLARE_TUNNEL_TEST_NAME_PREFIX` is set (used as the `name`
 *     prefix so different CI runs don't collide on the same label).
 *
 * The test selects a fresh, random-suffixed `name` on each run so leftover
 * resources from a failed run don't poison the next.
 */

const TUNNEL_TEST_PORT = 9881;

const skipNamedTunnel =
  (process.env.TEST_TRANSPORT ?? 'http') !== 'rpc' ||
  !process.env.CLOUDFLARE_API_TOKEN ||
  !process.env.CLOUDFLARE_ZONE_ID ||
  !process.env.CLOUDFLARE_TUNNEL_TEST_NAME_PREFIX;

interface NamedTunnelInfoWire {
  id: string;
  port: number;
  url: string;
  hostname: string;
  createdAt: string;
  name: string;
}

describe('Named tunnel round-trip', () => {
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

  test.skipIf(skipNamedTunnel)(
    'get(port, { name }) binds <name>.<zone> to the local port, destroy() removes it',
    async () => {
      const prefix = process.env.CLOUDFLARE_TUNNEL_TEST_NAME_PREFIX as string;
      const suffix = Math.random().toString(36).slice(2, 8);
      const name = `${prefix}-${suffix}`;
      const marker = `named-tunnel-${suffix}`;

      // 1. Boot a tiny server inside the sandbox.
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
          path: '/workspace/named-tunnel-server.ts',
          content: serverCode
        })
      });
      expect(writeResponse.status).toBe(200);

      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'bun run /workspace/named-tunnel-server.ts'
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

      // 2. Provision the named tunnel.
      const tunnel = await getNamedTunnel(TUNNEL_TEST_PORT, name);
      expect(tunnel.name).toBe(name);
      expect(tunnel.port).toBe(TUNNEL_TEST_PORT);
      // UUID format.
      expect(tunnel.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(tunnel.hostname).toMatch(new RegExp(`^${name}\\.`));
      expect(tunnel.url).toBe(`https://${tunnel.hostname}`);

      try {
        // 3. Idempotency: second get(port, { name }) returns the cached record.
        const second = await getNamedTunnel(TUNNEL_TEST_PORT, name);
        expect(second.id).toBe(tunnel.id);
        expect(second.url).toBe(tunnel.url);

        // 4. list() reflects the cached tunnel.
        const listed = await listTunnels();
        expect(listed.find((t) => t.id === tunnel.id)?.name).toBe(name);

        // 5. Fetch the marker through the public hostname. Edge
        //    propagation can take a few seconds even after /ready;
        //    retry briefly.
        const fetchedBody = await fetchWithRetry(
          `${tunnel.url}/marker`,
          marker,
          { tries: 15, delayMs: 2000 }
        );
        expect(fetchedBody).toBe(marker);
      } finally {
        // 6. Tear down. CF-side resources must be gone too.
        await destroyTunnel(TUNNEL_TEST_PORT);
        await fetch(`${workerUrl}/api/process/${processId}/kill`, {
          method: 'POST',
          headers
        }).catch(() => {});
      }

      // 7. The tunnel is no longer reachable from the public URL.
      //    Cloudflare returns an error page for a deleted tunnel; we
      //    just confirm the body no longer matches the marker.
      const afterDestroy = await fetch(`${tunnel.url}/marker`, {
        signal: AbortSignal.timeout(10_000)
      })
        .then((r) => r.text())
        .catch(() => '');
      expect(afterDestroy).not.toBe(marker);

      // 8. list() drops the entry.
      const after = await listTunnels();
      expect(after.map((t) => t.id)).not.toContain(tunnel.id);
    },
    240_000
  );

  // ---- helpers --------------------------------------------------------

  async function getNamedTunnel(
    port: number,
    name: string
  ): Promise<NamedTunnelInfoWire> {
    const r = await fetch(`${workerUrl}/api/tunnel/get`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ port, options: { name } })
    });
    expect(r.status).toBe(200);
    return (await r.json()) as NamedTunnelInfoWire;
  }

  async function listTunnels(): Promise<NamedTunnelInfoWire[]> {
    const r = await fetch(`${workerUrl}/api/tunnel/list`, { headers });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { tunnels: NamedTunnelInfoWire[] };
    return body.tunnels;
  }

  async function destroyTunnel(port: number): Promise<void> {
    await fetch(`${workerUrl}/api/tunnel/${port}`, {
      method: 'DELETE',
      headers
    });
  }
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
