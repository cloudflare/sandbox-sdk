import type { Process } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fetchWithRetry } from './helpers/fetch-with-retry';
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
 * Skipped unless `CLOUDFLARE_API_TOKEN` is set on the worker env. The SDK
 * infers account id and zone id from the token when unambiguous; see
 * `tunnels/credentials.ts`.
 *
 * The test mints a fresh random suffix for the tunnel name on every run
 * so concurrent CI shards never collide on the same label. A
 * try/finally guarantees `destroyTunnel(port)` runs on assertion
 * failure too, so a flaky run does not leak a tunnel resource or a DNS
 * record on the configured zone.
 */

const TUNNEL_TEST_PORT = 9881;

const skipNamedTunnel = !process.env.CLOUDFLARE_API_TOKEN;

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
      // Generate the tunnel name at test time so concurrent CI shards never
      // collide on the same label. 8 hex chars is enough randomness for a
      // single test invocation; we also catch the "leftover from a previous
      // crash" case via the SDK's retry-friendly findTunnelByName path.
      const suffix = Math.random().toString(36).slice(2, 10);
      const name = `e2e-${suffix}`;
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
      let tunnel: NamedTunnelInfoWire | null = null;
      try {
        tunnel = await getNamedTunnel(TUNNEL_TEST_PORT, name);
        expect(tunnel.name).toBe(name);
        expect(tunnel.port).toBe(TUNNEL_TEST_PORT);
        // UUID format.
        expect(tunnel.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
        expect(tunnel.hostname).toMatch(new RegExp(`^${name}\\.`));
        expect(tunnel.url).toBe(`https://${tunnel.hostname}`);

        // 3. Idempotency: second get(port, { name }) returns the cached record.
        const second = await getNamedTunnel(TUNNEL_TEST_PORT, name);
        expect(second.id).toBe(tunnel.id);
        expect(second.url).toBe(tunnel.url);

        // 4. list() reflects the cached tunnel.
        const listed = await listTunnels();
        expect(listed.find((t) => t.id === tunnel?.id)?.name).toBe(name);

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
        // 6. Tear down whether the test passed or failed. Best-effort:
        //    a destroy failure here must not mask the original assertion
        //    failure, so swallow the inner error.
        await destroyTunnel(TUNNEL_TEST_PORT).catch(() => {});
        await fetch(`${workerUrl}/api/process/${processId}/kill`, {
          method: 'POST',
          headers
        }).catch(() => {});
      }

      // The remaining assertions only run if the try block succeeded.
      // Without this guard a teardown-time CF blip would obscure the
      // real failure above.
      if (!tunnel) return;

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
