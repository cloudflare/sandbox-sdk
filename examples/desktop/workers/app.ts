import { getSandbox, proxyToSandbox, Sandbox } from '@cloudflare/sandbox';

export { Sandbox };

const SANDBOX_ID = 'desktop-sandbox';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // Route preview URL requests (noVNC streaming uses this)
      const proxyResponse = await proxyToSandbox(request, env);
      if (proxyResponse) return proxyResponse;

      const url = new URL(request.url);
      const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);

      if (url.pathname === '/api/start' && request.method === 'POST') {
        const body = request.headers.get('content-type')?.includes('json')
          ? await request.json<{ resolution?: [number, number] }>()
          : {};
        await sandbox.desktop.start(
          body.resolution ? { resolution: body.resolution } : undefined
        );
        return Response.json({ success: true });
      }

      if (url.pathname === '/api/stop' && request.method === 'POST') {
        await sandbox.desktop.stop();
        return Response.json({ success: true });
      }

      if (url.pathname === '/api/status') {
        return Response.json(await sandbox.desktop.status());
      }

      if (url.pathname === '/api/screenshot') {
        const { data, imageFormat } = await sandbox.desktop.screenshot();
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Response(bytes, {
          headers: {
            'Content-Type': `image/${imageFormat}`,
            'Cache-Control': 'no-store'
          }
        });
      }

      if (url.pathname === '/api/stream-url' && request.method === 'POST') {
        const hostname = url.hostname + (url.port ? `:${url.port}` : '');
        const { url: baseUrl } = await sandbox.getDesktopStreamUrl(hostname);
        const streamUrl = `${baseUrl}vnc.html?autoconnect=true&resize=scale`;
        return Response.json({ url: streamUrl });
      }

      // Everything else → React SPA
      return env.ASSETS.fetch(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Worker error on ${request.method} ${new URL(request.url).pathname}: ${message}`
      );
      return Response.json({ error: message }, { status: 500 });
    }
  }
} satisfies ExportedHandler<Env>;
