import type { Process } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

/**
 * Named tunnel round-trip.
 *
 * Spawns a Bun HTTP server inside the sandbox, calls
 * `sandbox.tunnels.create(port, { mode: 'named', hostname })`, then
 * `fetch()`es the public hostname from outside and asserts the body
 * matches a random marker.
 *
 * The DO orchestrates everything Cloudflare-side:
 *   1. POST /accounts/:id/cfd_tunnel  (creates tunnel + token, tagged
 *                                       with `metadata.sandboxId`)
 *   2. POST /zones/:id/dns_records    (CNAME → <id>.cfargotunnel.com,
 *                                       proxied, comment: 'sandbox-<id>')
 *   3. RPC into the container which spawns
 *      `cloudflared tunnel run --token <…> --url http://localhost:<port>`
 *
 * After the test, `tunnels.destroy(...)` should:
 *   - SIGTERM cloudflared inside the container,
 *   - DELETE the DNS record,
 *   - DELETE the tunnel.
 *
 * Skipped unless TEST_TRANSPORT=rpc, the four CF env vars are set, and
 * the zone backing TUNNEL_HOSTNAME is active.
 */

const TUNNEL_TEST_PORT = 9872;

const requiredEnv = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_ZONE_ID',
  'TUNNEL_HOSTNAME'
] as const;
const missingEnv = requiredEnv.filter((k) => !process.env[k]);

const skipNamedTunnel =
  (process.env.TEST_TRANSPORT ?? 'http') !== 'rpc' || missingEnv.length > 0;

const TUNNEL_HOSTNAME = process.env.TUNNEL_HOSTNAME ?? '';
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';
const CF_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID ?? '';
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';

interface NamedTunnelInfo {
  id: string;
  mode: 'named';
  port: number;
  url: string;
  hostname: string;
  createdAt: string;
}

describe('Named tunnel round-trip', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let sandbox: TestSandbox | null = null;

  beforeAll(async () => {
    if (skipNamedTunnel) {
      // Still log so the skip is visible in CI output.
      // eslint-disable-next-line no-console
      console.log(
        `Skipping — TEST_TRANSPORT=${process.env.TEST_TRANSPORT ?? '<unset>'}, missing env: ${missingEnv.join(', ') || '<none>'}`
      );
      return;
    }
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();
  }, 300_000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
  }, 120_000);

  test.skipIf(skipNamedTunnel)(
    'provisions a named tunnel and serves traffic over the public hostname',
    async () => {
      // 1. Boot a Bun marker server inside the sandbox.
      const marker = `named-tunnel-${Math.random().toString(36).slice(2, 10)}`;
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
await Bun.sleep(300000);
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

      // 2. Create the named tunnel.
      const createStart = Date.now();
      const createResponse = await fetch(`${workerUrl}/api/tunnel/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          port: TUNNEL_TEST_PORT,
          hostname: TUNNEL_HOSTNAME
        })
      });
      const createDurationMs = Date.now() - createStart;
      expect(createResponse.status).toBe(200);
      const tunnel = (await createResponse.json()) as NamedTunnelInfo;
      // eslint-disable-next-line no-console
      console.log(
        `tunnel.create returned ${tunnel.url} in ${createDurationMs}ms`
      );

      expect(tunnel.mode).toBe('named');
      expect(tunnel.port).toBe(TUNNEL_TEST_PORT);
      expect(tunnel.hostname).toBe(TUNNEL_HOSTNAME);
      expect(tunnel.url).toBe(`https://${TUNNEL_HOSTNAME}`);
      // Tunnel id should be a CF UUID (8-4-4-4-12), not a quick- prefix.
      expect(tunnel.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );

      try {
        // 3. Verify Cloudflare-side tagging.
        const tunnelMeta = await cf<{
          metadata?: Record<string, unknown>;
          name?: string;
        }>(`accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnel.id}`, {
          method: 'GET'
        });
        expect(tunnelMeta.metadata?.createdBy).toBe('sandbox-sdk');
        expect(typeof tunnelMeta.metadata?.sandboxId).toBe('string');

        const dnsList = await cf<
          Array<{ id: string; content: string; comment?: string | null }>
        >(
          `zones/${CF_ZONE_ID}/dns_records?name=${encodeURIComponent(TUNNEL_HOSTNAME)}`,
          { method: 'GET' }
        );
        expect(dnsList.length).toBeGreaterThanOrEqual(1);
        const cnameRecord = dnsList.find(
          (r) => r.content === `${tunnel.id}.cfargotunnel.com`
        );
        expect(cnameRecord).toBeDefined();
        expect(cnameRecord?.comment).toMatch(/^sandbox-/);

        // 4. Hit the public URL. CF edge can take a few seconds to fully
        //    propagate after cloudflared reports `/ready`.
        const fetchedBody = await fetchWithRetry(
          `${tunnel.url}/marker`,
          marker,
          { tries: 15, delayMs: 1000 }
        );
        expect(fetchedBody).toBe(marker);
      } finally {
        // 5. Tear down. Both the container-side cloudflared and the
        //    DO-side CF resources should disappear.
        await fetch(
          `${workerUrl}/api/tunnel/${encodeURIComponent(tunnel.id)}`,
          { method: 'DELETE', headers }
        );
        await fetch(`${workerUrl}/api/process/${processId}/kill`, {
          method: 'POST',
          headers
        }).catch(() => {});
      }

      // 6. Confirm the CF resources are gone (idempotent best-effort).
      const dnsAfter = await cf<Array<{ id: string; content: string }>>(
        `zones/${CF_ZONE_ID}/dns_records?name=${encodeURIComponent(TUNNEL_HOSTNAME)}`,
        { method: 'GET' }
      );
      const stillThere = dnsAfter.find(
        (r) => r.content === `${tunnel.id}.cfargotunnel.com`
      );
      expect(stillThere).toBeUndefined();

      const tunnelAfter = await fetchRaw(
        `accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnel.id}`,
        { method: 'GET' }
      );
      // After delete, CF returns 404 (or marks it deleted_at != null).
      expect([200, 404]).toContain(tunnelAfter.status);
      if (tunnelAfter.status === 200) {
        const body = (await tunnelAfter.json()) as {
          result?: { deleted_at?: string | null };
        };
        expect(body.result?.deleted_at).toBeTruthy();
      }
    },
    240_000
  );
});

async function cf<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetchRaw(path, init);
  const body = (await res.json()) as {
    success: boolean;
    errors?: Array<{ code: number; message: string }>;
    result?: T;
  };
  if (!res.ok || !body.success) {
    const detail =
      body.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') ??
      `HTTP ${res.status}`;
    throw new Error(`Cloudflare API error (${path}): ${detail}`);
  }
  return body.result as T;
}

async function fetchRaw(path: string, init: RequestInit): Promise<Response> {
  return fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  });
}

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
