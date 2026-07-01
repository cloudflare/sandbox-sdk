import type { Process } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fetchWithRetry } from './helpers/fetch-with-retry';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

/**
 * Quick tunnel round-trip.
 *
 * Spawns a tiny Bun HTTP server inside the sandbox, calls
 * `sandbox.tunnels.get(port)`, then `fetch()`s the returned
 * `*.trycloudflare.com` URL from outside the container and asserts the
 * body matches. Then verifies the DO-storage caching contract:
 *
 *   - A second `get(port)` for the same port returns the same record.
 *   - `destroy(port)` then `get(port)` yields a new record.
 *   - `list()` reflects the storage view across the lifecycle.
 *
 * Quick tunnels need no Cloudflare credentials, so this is the cheapest
 * end-to-end check that the cloudflared binary, the TunnelManager
 * spawn/ready logic, and the RPC plumbing all work.
 */

const TUNNEL_TEST_PORT = 9871;

interface QuickTunnelInfo {
  id: string;
  port: number;
  url: string;
  hostname: string;
  createdAt: string;
  name?: never;
}

// Quick tunnels depend on cloudflared reaching Cloudflare's quick-tunnel
// service from inside the container. In local Docker/wrangler-dev this is
// environment-dependent and commonly fails with "cloudflared exited before
// becoming ready". Run this suite against the deployed E2E worker in CI,
// where network/egress is known-good.
const skipQuickTunnelLocally = !process.env.TEST_WORKER_URL;

describe.skipIf(skipQuickTunnelLocally)('Quick tunnel round-trip', () => {
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

  test('get() creates a *.trycloudflare.com URL that proxies to a server inside the sandbox', async () => {
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
    const tunnel = await getTunnel(TUNNEL_TEST_PORT);
    expect(tunnel.name).toBeUndefined();
    expect(tunnel.port).toBe(TUNNEL_TEST_PORT);
    expect(tunnel.url).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
    expect(tunnel.hostname).toMatch(/\.trycloudflare\.com$/);
    expect(tunnel.id).toMatch(/^quick-[0-9a-hjkmnp-tv-z]{20}$/);

    try {
      // 3. Idempotency: a second get() for the same port returns the
      //    identical record. No new cloudflared spawn, same URL.
      const second = await getTunnel(TUNNEL_TEST_PORT);
      expect(second.id).toBe(tunnel.id);
      expect(second.url).toBe(tunnel.url);

      // 4. list() reflects the cached tunnel.
      const listed = await listTunnels();
      expect(listed.map((t) => t.id)).toContain(tunnel.id);

      // 5. Fetch the marker through the public URL. The Cloudflare edge
      //    can take 10–20 seconds to register the *.trycloudflare.com
      //    route after cloudflared reports /ready, so allow a generous
      //    retry budget. CI has been observed to need >10s of polling.
      const fetchedBody = await fetchWithRetry(`${tunnel.url}/marker`, marker, {
        tries: 30,
        delayMs: 1000
      });
      expect(fetchedBody).toBe(marker);
    } finally {
      // 6. Clean up — the tunnel and the user process.
      await destroyTunnel(TUNNEL_TEST_PORT);
      await fetch(`${workerUrl}/api/process/${processId}/kill`, {
        method: 'POST',
        headers
      }).catch(() => {});
    }

    // 7. After destroy, the tunnel is no longer in list().
    const after = await listTunnels();
    expect(after.map((t) => t.id)).not.toContain(tunnel.id);
  }, 180_000);

  test('destroy() then get() returns a fresh record (new id, new URL)', async () => {
    // Boot a tiny server so the tunnel has something to point at.
    const port = TUNNEL_TEST_PORT + 10;
    const filePath = `/workspace/quick-tunnel-refresh-${port}.ts`;
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: filePath,
        content: `Bun.serve({ hostname: "0.0.0.0", port: ${port}, fetch() { return new Response("ok"); } });`
      })
    });
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: `bun run ${filePath}` })
    });
    const { id: processId } = (await startResponse.json()) as Process;
    await fetch(`${workerUrl}/api/process/${processId}/waitForPort`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ port, timeout: 15_000, mode: 'tcp' })
    });

    try {
      const first = await getTunnel(port);
      await destroyTunnel(port);
      const second = await getTunnel(port);
      expect(second.id).not.toBe(first.id);
      expect(second.url).not.toBe(first.url);
      expect(second.port).toBe(port);
    } finally {
      await destroyTunnel(port).catch(() => {});
      await fetch(`${workerUrl}/api/process/${processId}/kill`, {
        method: 'POST',
        headers
      }).catch(() => {});
    }
  }, 180_000);

  test('auto-clears the storage entry when cloudflared exits unexpectedly', async () => {
    const port = TUNNEL_TEST_PORT + 20;
    const filePath = `/workspace/quick-tunnel-crash-${port}.ts`;
    // Boot a tiny server so cloudflared has something to point at.
    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: filePath,
        content: `Bun.serve({ hostname: "0.0.0.0", port: ${port}, fetch() { return new Response("ok"); } });`
      })
    });
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: `bun run ${filePath}` })
    });
    const { id: processId } = (await startResponse.json()) as Process;
    await fetch(`${workerUrl}/api/process/${processId}/waitForPort`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ port, timeout: 15_000, mode: 'tcp' })
    });

    try {
      const tunnel = await getTunnel(port);
      // Tunnel is in the cache.
      expect((await listTunnels()).map((t) => t.id)).toContain(tunnel.id);

      // Kill the cloudflared process from inside the sandbox.
      // pgrep / pkill are part of procps which ships in the base
      // image; cloudflared was started by the container's
      // TunnelManager so it's a child of pid 1.
      const killResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: 'pkill -9 -f cloudflared' })
      });
      expect(killResponse.status).toBe(200);

      // Poll list() until the dead tunnel is evicted. The exit
      // callback fires inside the container's proc.exited handler,
      // crosses the capnweb session, and clears storage — a
      // handful of milliseconds in the happy case, but allow a few
      // seconds for the round-trip.
      let cleared = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const ids = (await listTunnels()).map((t) => t.id);
        if (!ids.includes(tunnel.id)) {
          cleared = true;
          break;
        }
      }
      expect(cleared).toBe(true);

      // A subsequent get(port) is now a clean cache miss — spawns
      // a fresh tunnel with a new id and URL.
      const fresh = await getTunnel(port);
      expect(fresh.id).not.toBe(tunnel.id);
      expect(fresh.url).not.toBe(tunnel.url);
    } finally {
      await destroyTunnel(port).catch(() => {});
      await fetch(`${workerUrl}/api/process/${processId}/kill`, {
        method: 'POST',
        headers
      }).catch(() => {});
    }
  }, 180_000);

  test('runs two tunnels on two different ports side by side', async () => {
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
      await fetch(`${workerUrl}/api/process/${processId}/waitForPort`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ port, timeout: 15_000, mode: 'tcp' })
      });
      return processId;
    };

    const processA = await startServer(portA, markerA);
    const processB = await startServer(portB, markerB);
    const tunnelA = await getTunnel(portA);
    const tunnelB = await getTunnel(portB);

    try {
      expect(tunnelA.id).not.toBe(tunnelB.id);
      expect(tunnelA.url).not.toBe(tunnelB.url);
      expect(tunnelA.port).toBe(portA);
      expect(tunnelB.port).toBe(portB);

      const listed = await listTunnels();
      const ids = listed.map((t) => t.id);
      expect(ids).toContain(tunnelA.id);
      expect(ids).toContain(tunnelB.id);

      // Each tunnel routes to its own backing port.
      const [bodyA, bodyB] = await Promise.all([
        fetchWithRetry(tunnelA.url, markerA, { tries: 30, delayMs: 1000 }),
        fetchWithRetry(tunnelB.url, markerB, { tries: 30, delayMs: 1000 })
      ]);
      expect(bodyA).toBe(markerA);
      expect(bodyB).toBe(markerB);
    } finally {
      await Promise.all([destroyTunnel(portA), destroyTunnel(portB)]);
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
  }, 240_000);

  // ---- helpers --------------------------------------------------------

  async function getTunnel(port: number): Promise<QuickTunnelInfo> {
    const r = await fetch(`${workerUrl}/api/tunnel/get`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ port })
    });
    expect(r.status).toBe(200);
    return (await r.json()) as QuickTunnelInfo;
  }

  async function listTunnels(): Promise<QuickTunnelInfo[]> {
    const r = await fetch(`${workerUrl}/api/tunnel/list`, { headers });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { tunnels: QuickTunnelInfo[] };
    return body.tunnels;
  }

  async function destroyTunnel(port: number): Promise<void> {
    await fetch(`${workerUrl}/api/tunnel/${port}`, {
      method: 'DELETE',
      headers
    });
  }
});
