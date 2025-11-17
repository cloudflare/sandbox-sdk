/**
 * Minimal test worker for integration tests
 *
 * Exposes SDK methods via HTTP endpoints for E2E testing.
 * Supports both default sessions (implicit) and explicit sessions via X-Session-Id header.
 */
import { Sandbox, getSandbox, proxyToSandbox } from '@cloudflare/sandbox';
export { Sandbox };

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  TEST_BUCKET: R2Bucket;
  // R2 credentials for bucket mounting tests
  CLOUDFLARE_ACCOUNT_ID?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
}

async function parseBody(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route requests to exposed container ports via their preview URLs
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    const url = new URL(request.url);
    const body = await parseBody(request);

    // Get sandbox ID from header
    // Sandbox ID determines which container instance (Durable Object)
    const sandboxId =
      request.headers.get('X-Sandbox-Id') || 'default-test-sandbox';

    // Check if keepAlive is requested
    const keepAliveHeader = request.headers.get('X-Sandbox-KeepAlive');
    const keepAlive = keepAliveHeader === 'true';

    const sandbox = getSandbox(env.Sandbox, sandboxId, {
      keepAlive
    });

    // Get session ID from header (optional)
    // If provided, retrieve the session fresh from the Sandbox DO on each request
    const sessionId = request.headers.get('X-Session-Id');

    // Executor pattern: retrieve session fresh if specified, otherwise use sandbox
    // Important: We get the session fresh on EVERY request to respect RPC lifecycle
    // The ExecutionSession stub is only valid during this request's execution context
    const executor = sessionId ? await sandbox.getSession(sessionId) : sandbox;

    try {
      // WebSocket init endpoint - starts all WebSocket servers
      if (url.pathname === '/api/init' && request.method === 'POST') {
        const processes = await sandbox.listProcesses();
        const runningServers = new Set(
          processes.filter((p) => p.status === 'running').map((p) => p.id)
        );

        const serversToStart = [];

        // Echo server
        if (!runningServers.has('ws-echo-8080')) {
          const echoScript = `
const port = 8080;
Bun.serve({
  port,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('Expected WebSocket', { status: 400 });
  },
  websocket: {
    message(ws, message) { ws.send(message); },
    open(ws) { console.log('Echo client connected'); },
    close(ws) { console.log('Echo client disconnected'); },
  },
});
console.log('Echo server on port ' + port);
`;
          await sandbox.writeFile('/tmp/ws-echo.ts', echoScript);
          serversToStart.push(
            sandbox.startProcess('bun run /tmp/ws-echo.ts', {
              processId: 'ws-echo-8080'
            })
          );
        }

        // Python code server
        if (!runningServers.has('ws-code-8081')) {
          const codeScript = `
const port = 8081;
Bun.serve({
  port,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('Expected WebSocket', { status: 400 });
  },
  websocket: {
    async message(ws, message) {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'execute') {
          ws.send(JSON.stringify({ type: 'executing', timestamp: Date.now() }));
          const filename = '/tmp/code_' + Date.now() + '.py';
          await Bun.write(filename, data.code);
          const proc = Bun.spawn(['python3', filename], { stdout: 'pipe', stderr: 'pipe' });
          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                if (text) ws.send(JSON.stringify({ type: 'stdout', data: text, timestamp: Date.now() }));
              }
            } catch (e) {}
          })();
          const stderrReader = proc.stderr.getReader();
          (async () => {
            try {
              while (true) {
                const { done, value } = await stderrReader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                if (text) ws.send(JSON.stringify({ type: 'stderr', data: text, timestamp: Date.now() }));
              }
            } catch (e) {}
          })();
          const exitCode = await proc.exited;
          ws.send(JSON.stringify({ type: 'completed', exitCode, timestamp: Date.now() }));
          try { await Bun.spawn(['rm', '-f', filename]).exited; } catch (e) {}
        }
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', message: error.message, timestamp: Date.now() }));
      }
    },
    open(ws) { ws.send(JSON.stringify({ type: 'ready', message: 'Code server ready', timestamp: Date.now() })); },
  },
});
console.log('Code server on port ' + port);
`;
          await sandbox.writeFile('/tmp/ws-code.ts', codeScript);
          serversToStart.push(
            sandbox.startProcess('bun run /tmp/ws-code.ts', {
              processId: 'ws-code-8081'
            })
          );
        }

        // Terminal server
        if (!runningServers.has('ws-terminal-8082')) {
          const terminalScript = `
const port = 8082;
Bun.serve({
  port,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('Expected WebSocket', { status: 400 });
  },
  websocket: {
    async message(ws, message) {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'command') {
          ws.send(JSON.stringify({ type: 'executing', command: data.command, timestamp: Date.now() }));
          const proc = Bun.spawn(['sh', '-c', data.command], { stdout: 'pipe', stderr: 'pipe' });
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;
          ws.send(JSON.stringify({ type: 'result', stdout, stderr, exitCode, timestamp: Date.now() }));
        }
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', message: error.message, timestamp: Date.now() }));
      }
    },
    open(ws) { ws.send(JSON.stringify({ type: 'ready', message: 'Terminal ready', cwd: process.cwd(), timestamp: Date.now() })); },
  },
});
console.log('Terminal server on port ' + port);
`;
          await sandbox.writeFile('/tmp/ws-terminal.ts', terminalScript);
          serversToStart.push(
            sandbox.startProcess('bun run /tmp/ws-terminal.ts', {
              processId: 'ws-terminal-8082'
            })
          );
        }

        // Start all servers and track results
        const results = await Promise.allSettled(serversToStart);
        const failedCount = results.filter(
          (r) => r.status === 'rejected'
        ).length;
        const succeededCount = results.filter(
          (r) => r.status === 'fulfilled'
        ).length;

        return new Response(
          JSON.stringify({
            success: failedCount === 0,
            serversStarted: succeededCount,
            serversFailed: failedCount,
            errors:
              failedCount > 0
                ? results
                    .filter((r) => r.status === 'rejected')
                    .map(
                      (r) =>
                        (r as PromiseRejectedResult).reason?.message ||
                        String((r as PromiseRejectedResult).reason)
                    )
                : undefined
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: failedCount > 0 ? 500 : 200
          }
        );
      }

      // WebSocket endpoints
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        if (url.pathname === '/ws/echo') {
          return await sandbox.wsConnect(request, 8080);
        }
        if (url.pathname === '/ws/code') {
          return await sandbox.wsConnect(request, 8081);
        }
        if (url.pathname === '/ws/terminal') {
          return await sandbox.wsConnect(request, 8082);
        }
      }

      // Health check
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Session management
      if (url.pathname === '/api/session/create' && request.method === 'POST') {
        const session = await sandbox.createSession(body);
        // Note: We don't store the session - it will be retrieved fresh via getSession() on each request
        return new Response(
          JSON.stringify({ success: true, sessionId: session.id }),
          {
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      if (url.pathname === '/api/session/delete' && request.method === 'POST') {
        const result = await sandbox.deleteSession(body.sessionId);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Command execution
      if (url.pathname === '/api/execute' && request.method === 'POST') {
        const result = await executor.exec(body.command);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Command execution with streaming
      if (url.pathname === '/api/execStream' && request.method === 'POST') {
        console.log(
          '[TestWorker] execStream called for command:',
          body.command
        );
        const startTime = Date.now();
        const stream = await executor.execStream(body.command);
        console.log(
          '[TestWorker] Stream received in',
          Date.now() - startTime,
          'ms'
        );

        // Return SSE stream directly
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          }
        });
      }

      // Git clone
      if (url.pathname === '/api/git/clone' && request.method === 'POST') {
        await executor.gitCheckout(body.repoUrl, {
          branch: body.branch,
          targetDir: body.targetDir
        });
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Bucket mount
      if (url.pathname === '/api/bucket/mount' && request.method === 'POST') {
        // Pass R2 credentials from worker env to sandbox env
        const sandboxEnvVars: Record<string, string> = {};
        if (env.CLOUDFLARE_ACCOUNT_ID) {
          sandboxEnvVars.CLOUDFLARE_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID;
        }
        if (env.AWS_ACCESS_KEY_ID) {
          sandboxEnvVars.AWS_ACCESS_KEY_ID = env.AWS_ACCESS_KEY_ID;
        }
        if (env.AWS_SECRET_ACCESS_KEY) {
          sandboxEnvVars.AWS_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY;
        }

        if (Object.keys(sandboxEnvVars).length > 0) {
          await sandbox.setEnvVars(sandboxEnvVars);
        }

        await sandbox.mountBucket(body.bucket, body.mountPath, body.options);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // R2 bucket put
      if (url.pathname === '/api/bucket/put' && request.method === 'POST') {
        await env.TEST_BUCKET.put(body.key, body.content, {
          httpMetadata: body.contentType
            ? { contentType: body.contentType }
            : undefined
        });
        return new Response(JSON.stringify({ success: true, key: body.key }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // R2 bucket get
      if (url.pathname === '/api/bucket/get' && request.method === 'GET') {
        const key = url.searchParams.get('key');
        if (!key) {
          return new Response(
            JSON.stringify({ error: 'Key parameter required' }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        }
        const object = await env.TEST_BUCKET.get(key);
        if (!object) {
          return new Response(JSON.stringify({ error: 'Object not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(
          JSON.stringify({
            success: true,
            key,
            content: await object.text(),
            contentType: object.httpMetadata?.contentType,
            size: object.size
          }),
          {
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      // R2 bucket delete
      if (url.pathname === '/api/bucket/delete' && request.method === 'POST') {
        await env.TEST_BUCKET.delete(body.key);
        return new Response(JSON.stringify({ success: true, key: body.key }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File read
      if (url.pathname === '/api/file/read' && request.method === 'POST') {
        const file = await executor.readFile(body.path);
        return new Response(JSON.stringify(file), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File read stream
      if (url.pathname === '/api/read/stream' && request.method === 'POST') {
        const stream = await executor.readFileStream(body.path);
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          }
        });
      }

      // File write
      if (url.pathname === '/api/file/write' && request.method === 'POST') {
        await executor.writeFile(body.path, body.content);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File mkdir
      if (url.pathname === '/api/file/mkdir' && request.method === 'POST') {
        await executor.mkdir(body.path, { recursive: body.recursive });
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File delete
      if (url.pathname === '/api/file/delete' && request.method === 'DELETE') {
        await executor.deleteFile(body.path);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File rename
      if (url.pathname === '/api/file/rename' && request.method === 'POST') {
        await executor.renameFile(body.oldPath, body.newPath);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File move
      if (url.pathname === '/api/file/move' && request.method === 'POST') {
        await executor.moveFile(body.sourcePath, body.destinationPath);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // List files
      if (url.pathname === '/api/list-files' && request.method === 'POST') {
        const result = await executor.listFiles(body.path, body.options);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File exists
      if (url.pathname === '/api/file/exists' && request.method === 'POST') {
        const result = await executor.exists(body.path);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Process start
      if (url.pathname === '/api/process/start' && request.method === 'POST') {
        const process = await executor.startProcess(body.command);
        return new Response(JSON.stringify(process), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Process list
      if (url.pathname === '/api/process/list' && request.method === 'GET') {
        const processes = await executor.listProcesses();
        return new Response(JSON.stringify(processes), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Process get by ID
      if (
        url.pathname.startsWith('/api/process/') &&
        request.method === 'GET'
      ) {
        const pathParts = url.pathname.split('/');
        const processId = pathParts[3];

        // Handle /api/process/:id/logs
        if (pathParts[4] === 'logs') {
          const logs = await executor.getProcessLogs(processId);
          return new Response(JSON.stringify(logs), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Handle /api/process/:id/stream (SSE)
        if (pathParts[4] === 'stream') {
          const stream = await executor.streamProcessLogs(processId);

          // Convert AsyncIterable to ReadableStream for SSE
          const readableStream = new ReadableStream({
            async start(controller) {
              try {
                for await (const event of stream) {
                  const sseData = `data: ${JSON.stringify(event)}\n\n`;
                  controller.enqueue(new TextEncoder().encode(sseData));
                }
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            }
          });

          return new Response(readableStream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive'
            }
          });
        }

        // Handle /api/process/:id (get single process)
        if (!pathParts[4]) {
          const process = await executor.getProcess(processId);
          return new Response(JSON.stringify(process), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      // Process kill by ID
      if (
        url.pathname.startsWith('/api/process/') &&
        request.method === 'DELETE'
      ) {
        const processId = url.pathname.split('/')[3];
        await executor.killProcess(processId);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Kill all processes
      if (
        url.pathname === '/api/process/kill-all' &&
        request.method === 'POST'
      ) {
        await executor.killAllProcesses();
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Port exposure (ONLY works with sandbox - sessions don't expose ports)
      if (url.pathname === '/api/port/expose' && request.method === 'POST') {
        if (sessionId) {
          return new Response(
            JSON.stringify({
              error:
                'Port exposure not supported for explicit sessions. Use default sandbox.'
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        }
        // Extract hostname from the request
        const hostname = url.hostname + (url.port ? `:${url.port}` : '');
        const preview = await sandbox.exposePort(body.port, {
          name: body.name,
          hostname: hostname
        });
        return new Response(JSON.stringify(preview), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Port unexpose (ONLY works with sandbox - sessions don't expose ports)
      if (
        url.pathname.startsWith('/api/exposed-ports/') &&
        request.method === 'DELETE'
      ) {
        if (sessionId) {
          return new Response(
            JSON.stringify({
              error:
                'Port exposure not supported for explicit sessions. Use default sandbox.'
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        }
        const pathParts = url.pathname.split('/');
        const port = parseInt(pathParts[3], 10);
        if (!Number.isNaN(port)) {
          await sandbox.unexposePort(port);
          return new Response(JSON.stringify({ success: true, port }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      // Environment variables
      if (url.pathname === '/api/env/set' && request.method === 'POST') {
        await executor.setEnvVars(body.envVars);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Code Interpreter - Create Context
      if (
        url.pathname === '/api/code/context/create' &&
        request.method === 'POST'
      ) {
        const context = await executor.createCodeContext(body);
        return new Response(JSON.stringify(context), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Code Interpreter - List Contexts
      if (
        url.pathname === '/api/code/context/list' &&
        request.method === 'GET'
      ) {
        const contexts = await executor.listCodeContexts();
        return new Response(JSON.stringify(contexts), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Code Interpreter - Delete Context
      if (
        url.pathname.startsWith('/api/code/context/') &&
        request.method === 'DELETE'
      ) {
        const pathParts = url.pathname.split('/');
        const contextId = pathParts[4]; // /api/code/context/:id
        await executor.deleteCodeContext(contextId);
        return new Response(JSON.stringify({ success: true, contextId }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Code Interpreter - Execute Code
      if (url.pathname === '/api/code/execute' && request.method === 'POST') {
        const execution = await executor.runCode(body.code, body.options || {});
        return new Response(JSON.stringify(execution), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Code Interpreter - Execute Code with Streaming
      if (
        url.pathname === '/api/code/execute/stream' &&
        request.method === 'POST'
      ) {
        const stream = await executor.runCodeStream(
          body.code,
          body.options || {}
        );
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          }
        });
      }

      // Cleanup endpoint - destroys the sandbox container
      // This is used by E2E tests to explicitly clean up after each test
      if (url.pathname === '/cleanup' && request.method === 'POST') {
        await sandbox.destroy();
        return new Response(
          JSON.stringify({ success: true, message: 'Sandbox destroyed' }),
          {
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error'
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }
};
