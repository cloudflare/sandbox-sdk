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

  let proc = await sandbox.getProcess('vite-dev-server');
  if (!proc) {
    // `processId` makes the background process addressable via
    // `sandbox.getProcess()` on later requests.
    proc = await sandbox.exec('npm run dev', {
      processId: 'vite-dev-server',
      cwd: '/app',
      env: {
        VITE_PORT: `${VITE_PORT}`
      }
    });
    await proc.waitForPort(VITE_PORT);
  }

  try {
    const tunnel = await sandbox.tunnels.get(VITE_PORT);
    return Response.json({ url: tunnel.url });
  } catch (error) {
    // cloudflared tunnels don't work when WARP is running.
    if (
      error instanceof Error &&
      'errorResponse' in error &&
      error.errorResponse.code === 'TUNNEL_START_ERROR'
    ) {
      const detail =
        'Failed to create Cloudflare Tunnel. If you are running WARP please ensure it is disabled';
      console.error({ message: detail, error });
      return Response.json({ detail }, { status: 503 });
    }

    return Response.json({ detail: `${error}` }, { status: 500 });
  }
}
