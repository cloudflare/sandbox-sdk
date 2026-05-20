import { getSandbox, type TunnelInfo } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

const WS_PORT = 8080;

/**
 * Spin up (or reuse) a Cloudflare Tunnel pointing at the WebSocket server
 * inside the sandbox.
 *
 * Two modes:
 *  - **Named tunnel** when `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`,
 *    and `TUNNEL_NAME` are all set. The tunnel binds the user-controlled
 *    hostname `<TUNNEL_NAME>.<zone>` and survives DO eviction (the SDK
 *    rediscovers the tagged Cloudflare resources on re-run).
 *  - **Quick tunnel** otherwise. Zero-config, but the `*.trycloudflare.com`
 *    URL changes on every container restart.
 */
interface TunnelResult {
  tunnel: TunnelInfo | null;
  /** Human-readable diagnostic surfaced to the user when `tunnel` is null. */
  error?: string;
}

async function getTunnel(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env
): Promise<TunnelResult> {
  // Treat `TUNNEL_NAME` (and the required Cloudflare credentials) as the
  // opt-in switch. Any missing piece falls through to the zero-config quick
  // tunnel so the example still runs without setup.
  const tunnelName = readVar(env, 'TUNNEL_NAME');
  const hasNamedCreds =
    Boolean(tunnelName) &&
    Boolean(readVar(env, 'CLOUDFLARE_API_TOKEN')) &&
    Boolean(readVar(env, 'CLOUDFLARE_ZONE_ID'));

  try {
    const tunnel = hasNamedCreds
      ? await sandbox.tunnels.get(WS_PORT, { name: tunnelName })
      : await sandbox.tunnels.get(WS_PORT);
    return { tunnel };
  } catch (err) {
    console.error('Failed to provision tunnel:', err);
    // The SDK exposes `err.code` on its typed errors. When the container
    // can't find the cloudflared binary, surface that distinctly so the
    // user knows what to fix.
    const code = (err as { code?: string })?.code;
    if (code === 'CLOUDFLARED_NOT_FOUND') {
      return {
        tunnel: null,
        error: 'cloudflared could not be found on this system.'
      };
    }
    return { tunnel: null };
  }
}

function readVar(env: Env, key: string): string {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/') {
      return env.Assets.fetch(request);
    }

    const sandbox = getSandbox(env.Sandbox, 'websocket-demo');

    const proc = await sandbox.getProcess('ws-server');
    if (!proc) {
      const proc = await sandbox.startProcess('bun /app/server.js', {
        processId: 'ws-server',
        env: { PORT: `${WS_PORT}` }
      });
      await proc.waitForPort(WS_PORT);
    }

    const { tunnel, error } = await getTunnel(sandbox, env);
    if (!tunnel) {
      return new Response(
        error ??
          'Unable to create Cloudflare Tunnel. Note, if you are running Cloudflare WARP you will need to disable WARP to access the tunnel in local development.',
        { status: 500 }
      );
    }

    // Render the public/index.html page and inject the sandbox websocket endpoint
    // as an attribute on the <html> element so the script can use it.
    return new HTMLRewriter()
      .on('html', {
        element(element) {
          element.setAttribute('data-sandbox-endpoint', `${tunnel.url}/ws`);
        }
      })
      .transform(await env.Assets.fetch(request));
  }
};
