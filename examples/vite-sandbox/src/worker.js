import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

const VITE_PORT = 5173;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/sandbox') {
      return handleAPISandboxRoute(env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

async function handleAPISandboxRoute(env) {
  const sandbox = getSandbox(env.Sandbox, 'vite-sandbox');

  const proc = await sandbox.getProcess('vite-dev-server');
  if (!proc) {
    const proc = await sandbox.startProcess('npm run dev', {
      processId: 'vite-dev-server',
      cwd: '/app',
      env: {
        VITE_PORT: `${VITE_PORT}`,
        VITE_HMR_CLIENT_PORT: '443' // Cloudflare Tunnel is always https
      }
    });
    await proc.waitForPort(VITE_PORT);
  }

  try {
    const tunnel = await sandbox.tunnels.get(VITE_PORT);
    return Response.json({ url: tunnel.url });
  } catch (error) {
    console.error({
      message:
        'Failed to create Cloudflare Tunnel. If you are running WARP please ensure it is disabled',
      error
    });
    return Response.json(
      {
        detail:
          'Failed to create Cloudflare Tunnel. If you are running WARP please ensure it is disabled.'
      },
      { status: 500 }
    );
  }
}
