import { getSandbox, proxyToSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

const VITE_PORT = 5173;

export default {
  async fetch(request, env) {
    console.log(
      'request.url',
      request.url,
      'request.headers.host',
      request.headers.get('host')
    );
    const proxiedResponse = await proxyToSandbox(request, env);
    if (proxiedResponse) {
      return proxiedResponse;
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/sandbox') {
      return sandboxApi(url, env);
    }

    return new Response('Not found', { status: 404 });
  }
};

async function sandboxApi(url, env) {
  const sandbox = getSandbox(env.Sandbox, 'vite-sandbox');

  const existingPort = await sandbox
    .getExposedPorts(url.host)
    .then((ports) => ports.find((p) => p.port === VITE_PORT));

  if (existingPort) {
    return Response.json({ url: `${existingPort.url}` });
  }

  const port = await sandbox.exposePort(VITE_PORT, { hostname: url.host });

  await sandbox.startProcess('npm run dev', {
    processId: 'vite-dev-server',
    cwd: '/app'
  });
  await sandbox.waitForPort({ portToCheck: VITE_PORT });
  await sandbox.startProcess('bun /app/counter.js', {
    processId: 'counter'
  });

  return Response.json({ url: `${port.url}` });
}
