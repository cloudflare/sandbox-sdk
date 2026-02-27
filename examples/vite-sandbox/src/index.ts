import { getSandbox, proxyToSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

const VITE_PORT = 5173;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proxiedResponse = await proxyToSandbox(request, env);
    if (proxiedResponse) {
      return proxiedResponse;
    }

    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, 'vite-sandbox');

    let port: { port: number; url: string } | undefined = await sandbox
      .getExposedPorts(url.host)
      .then((ports) => ports.find((p) => p.port === VITE_PORT));

    if (!port) {
      port = await sandbox.exposePort(VITE_PORT, { hostname: url.host });

      await sandbox.startProcess('npm run dev', {
        processId: 'vite-dev-server',
        cwd: '/app'
      });
      await sandbox.waitForPort({ portToCheck: VITE_PORT });

      await sandbox.startProcess('bun /app/counter.js', {
        processId: 'counter'
      });
    }

    const proxy = new Request(port.url, request);
    const response = await proxyToSandbox(proxy, env);

    if (!response) {
      return new Response('Unexpected error', { status: 500 });
    }

    return new HTMLRewriter()
      .on('head', {
        element: (el) => {
          el.before(`<base href="${port.url}" />\n`, { html: true });
        }
      })
      .transform(response);
  }
};
