import { getSandbox, proxyToSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

const VITE_PORT = 5173;
const VITE_BASE = '/_/';

export default {
  async fetch(request, env) {
    const proxiedResponse = await proxyToSandbox(request, env);
    if (proxiedResponse) {
      return proxiedResponse;
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/sandbox') {
      return handleAPISandboxRoute(url, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

async function handleAPISandboxRoute(url, env) {
  const sandbox = getSandbox(env.Sandbox, 'vite-sandbox');

  let port = await sandbox
    .getExposedPorts(url.host)
    .then((ports) => ports.find((p) => p.port === VITE_PORT));

  if (!port) {
    port = await sandbox.exposePort(VITE_PORT, { hostname: url.host });

    const process = await sandbox.startProcess('npm run dev', {
      processId: 'vite-dev-server',
      cwd: '/app',
      env: {
        VITE_BASE: VITE_BASE,
        VITE_PORT: `${VITE_PORT}`,
        VITE_HMR_CLIENT_PORT:
          url.port || (url.protocol === 'https:' ? '443' : '80')
      }
    });
    await process.waitForPort(VITE_PORT);
  }

  return Response.json({ url: `${port.url.replace(/\/$/, '')}${VITE_BASE}` });
}
