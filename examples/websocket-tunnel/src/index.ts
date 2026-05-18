import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

const WS_PORT = 8080;

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

    const tunnel = await sandbox.tunnels.get(WS_PORT);
    if (!tunnel) {
      return new Response(
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
