import { getSandbox, proxyToSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

const WS_PORT = 8080;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proxiedResponse = await proxyToSandbox(request, env);
    if (proxiedResponse) {
      return proxiedResponse;
    }

    const url = new URL(request.url);
    if (url.pathname !== '/') {
      return env.Assets.fetch(request);
    }

    const sandbox = getSandbox(env.Sandbox, 'websocket-demo');

    let port: { url: string; port: number } | undefined = await sandbox
      .getExposedPorts(url.host)
      .then((ports) => ports.find((p) => p.port === WS_PORT));
    if (!port) {
      const p = await sandbox.exposePort(WS_PORT, { hostname: url.host });

      const proc = await sandbox.startProcess('bun /app/server.js', {
        processId: 'ws-server'
      });
      await proc.waitForPort(WS_PORT);

      port = p;
    }

    // Render the public/index.html page and inject the sandbox websocket endpoint
    // as an attribute on the <html> element so the script can use it.
    return new HTMLRewriter()
      .on('html', {
        element(element) {
          element.setAttribute('data-sandbox-endpoint', `${port.url}ws`);
        }
      })
      .transform(await env.Assets.fetch(request));
  }
};
