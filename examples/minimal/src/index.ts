import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Get or create a sandbox instance
    const sandbox = getSandbox(env.Sandbox, 'my-sandbox');

    // Execute a shell command
    if (url.pathname === '/run') {
      const result = await sandbox.exec('echo "2 + 2 = $((2 + 2))"');
      return Response.json({
        output: result.stdout,
        error: result.stderr,
        exitCode: result.exitCode,
        success: result.success
      });
    }

    // Work with files
    if (url.pathname === '/file') {
      await sandbox.writeFile('/workspace/hello.txt', 'Hello, Sandbox!');
      const file = await sandbox.readFile('/workspace/hello.txt');
      return Response.json({
        content: file.content
      });
    }

    // Start a background job that will emit lifecycle events
    if (url.pathname === '/job') {
      const process = await sandbox.startProcess(
        'sh -c "echo starting && sleep 1 && echo done"'
      );
      return Response.json({ processId: process.id, pid: process.pid });
    }

    // Inspect the lifecycle event log for audit or replay use cases
    if (url.pathname === '/events') {
      const afterSeqParam = url.searchParams.get('afterSeq');
      const afterSeq =
        afterSeqParam === null ? undefined : Number.parseInt(afterSeqParam, 10);
      const events = await sandbox.listEvents({ afterSeq, limit: 50 });
      return Response.json({ events });
    }

    // Configure a local webhook receiver for demo purposes
    if (url.pathname === '/webhook/configure') {
      const subscriptions = await sandbox.setEventWebhooks([
        {
          url: `${url.origin}/webhook/receiver`,
          secret: 'dev-secret',
          types: ['session.created', 'process.exited', 'port.exposed']
        }
      ]);
      return Response.json({ subscriptions });
    }

    // Simple webhook receiver example. Replace this with your job runner,
    // queue consumer, or audit pipeline in production.
    if (url.pathname === '/webhook/receiver' && request.method === 'POST') {
      const body = await request.json();
      console.log('Received lifecycle webhook', body);
      return Response.json({ ok: true });
    }

    return new Response(
      'Try /run, /file, /job, /events, /webhook/configure, or /webhook/receiver'
    );
  }
};
