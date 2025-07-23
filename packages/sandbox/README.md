## @cloudflare/sandbox

> **⚠️ Experimental** - This library is currently experimental and we're actively seeking feedback. Please try it out and let us know what you think!

A library to spin up a sandboxed environment.

First, setup your wrangler.json to use the sandbox:

```jsonc
{
  // ...
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./node_modules/@cloudflare/sandbox/Dockerfile",
      "name": "sandbox"
    }
  ],
  "durable_objects": {
    "bindings": [
      {
        "class_name": "Sandbox",
        "name": "Sandbox"
      }
    ]
  },
  "migrations": [
    {
      "new_sqlite_classes": ["Sandbox"],
      "tag": "v1"
    }
  ]
}
```

Then, export the Sandbox class in your worker:

```ts
export { Sandbox } from "@cloudflare/sandbox";
```

You can then use the Sandbox class in your worker:

```ts
import { getSandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env) {
    const sandbox = getSandbox(env.Sandbox, "my-sandbox");
    const result = await sandbox.exec("ls -la");
    return Response.json(result);
  },
};
```

### Core Methods

#### Command Execution
- `exec(command: string, options?: ExecOptions)`: Execute a command and return the complete result.
- `execStream(command: string, options?: StreamOptions)`: Execute a command with real-time streaming (returns ReadableStream).

#### Process Management
- `startProcess(command: string, options?: ProcessOptions)`: Start a background process.
- `listProcesses()`: List all running processes.
- `getProcess(id: string)`: Get details of a specific process.
- `killProcess(id: string, signal?: string)`: Kill a specific process.
- `killAllProcesses()`: Kill all running processes.
- `streamProcessLogs(processId: string, options?: { signal?: AbortSignal })`: Stream logs from a running process (returns ReadableStream).

#### File Operations
- `gitCheckout(repoUrl: string, options: { branch?: string; targetDir?: string })`: Checkout a git repository.
- `mkdir(path: string, options?: { recursive?: boolean })`: Create a directory.
- `writeFile(path: string, content: string, options?: { encoding?: string })`: Write content to a file.
- `readFile(path: string, options?: { encoding?: string })`: Read content from a file.
- `deleteFile(path: string)`: Delete a file.
- `renameFile(oldPath: string, newPath: string)`: Rename a file.
- `moveFile(sourcePath: string, destinationPath: string)`: Move a file.

#### Port Management
- `exposePort(port: number, options: { name?: string; hostname: string })`: Expose a port for external access.
- `unexposePort(port: number)`: Unexpose a previously exposed port.
- `getExposedPorts(hostname: string)`: List all exposed ports with their preview URLs.

### Beautiful AsyncIterable Streaming APIs ✨

The SDK provides streaming methods that return `ReadableStream` for RPC compatibility, along with a `parseSSEStream` utility to convert them to typed AsyncIterables:

#### Stream Command Output
```typescript
import { parseSSEStream, type ExecEvent } from '@cloudflare/sandbox';

// Get the stream and convert to AsyncIterable
const stream = await sandbox.execStream('npm run build');
for await (const event of parseSSEStream<ExecEvent>(stream)) {
  switch (event.type) {
    case 'start':
      console.log(`Build started: ${event.command}`);
      break;
    case 'stdout':
      console.log(`[OUT] ${event.data}`);
      break;
    case 'stderr':
      console.error(`[ERR] ${event.data}`);
      break;
    case 'complete':
      console.log(`Build finished with exit code: ${event.exitCode}`);
      break;
    case 'error':
      console.error(`Build error: ${event.error}`);
      break;
  }
}
```

#### Stream Process Logs
```typescript
import { parseSSEStream, type LogEvent } from '@cloudflare/sandbox';

// Monitor background process logs
const webServer = await sandbox.startProcess('node server.js');

const logStream = await sandbox.streamProcessLogs(webServer.id);
for await (const log of parseSSEStream<LogEvent>(logStream)) {
  if (log.type === 'stdout') {
    console.log(`Server: ${log.data}`);
  } else if (log.type === 'stderr' && log.data.includes('ERROR')) {
    // React to errors
    await handleError(log);
  } else if (log.type === 'exit') {
    console.log(`Server exited with code: ${log.exitCode}`);
    break;
  }
}
```

#### Why parseSSEStream?

The streaming methods return `ReadableStream<Uint8Array>` to ensure compatibility across Durable Object RPC boundaries. The `parseSSEStream` utility converts these streams into typed AsyncIterables, giving you the best of both worlds:

- **RPC Compatibility**: ReadableStream can be serialized across process boundaries
- **Beautiful APIs**: AsyncIterable provides clean `for await` syntax with typed events
- **Type Safety**: Full TypeScript support with `ExecEvent` and `LogEvent` types

#### Advanced Examples

##### CI/CD Build System
```typescript
import { parseSSEStream, type ExecEvent } from '@cloudflare/sandbox';

export async function runBuild(env: Env, buildId: string) {
  const sandbox = getSandbox(env.Sandbox, buildId);
  const buildLog: string[] = [];

  try {
    const stream = await sandbox.execStream('npm run build');
    for await (const event of parseSSEStream<ExecEvent>(stream)) {
      buildLog.push(`[${event.type}] ${event.data || ''}`);

      if (event.type === 'complete') {
        await env.BUILDS.put(buildId, {
          status: event.exitCode === 0 ? 'success' : 'failed',
          exitCode: event.exitCode,
          logs: buildLog.join('\n'),
          duration: Date.now() - new Date(event.timestamp).getTime()
        });
      }
    }
  } catch (error) {
    await env.BUILDS.put(buildId, {
      status: 'error',
      error: error.message,
      logs: buildLog.join('\n')
    });
  }
}
```

##### System Monitoring
```typescript
import { parseSSEStream, type LogEvent } from '@cloudflare/sandbox';

export default {
  async scheduled(controller: ScheduledController, env: Env) {
    const sandbox = getSandbox(env.Sandbox, 'monitor');

    // Monitor system logs
    const monitor = await sandbox.startProcess('journalctl -f');

    const logStream = await sandbox.streamProcessLogs(monitor.id);
    for await (const log of parseSSEStream<LogEvent>(logStream)) {
      if (log.type === 'stdout') {
        // Check for critical errors
        if (log.data.includes('CRITICAL')) {
          await env.ALERTS.send({
            severity: 'critical',
            message: log.data,
            timestamp: log.timestamp
          });
        }

        // Store logs
        await env.LOGS.put(`${log.timestamp}-${monitor.id}`, log.data);
      }
    }
  }
}
```

##### Streaming to Frontend via SSE
```typescript
// Worker endpoint that streams to frontend
app.get('/api/build/:id/stream', async (req, env) => {
  const sandbox = getSandbox(env.Sandbox, req.params.id);
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for await (const event of sandbox.execStream('npm run build')) {
            // Forward events to frontend as SSE
            const sseEvent = `data: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(sseEvent));
          }
        } catch (error) {
          const errorEvent = `data: ${JSON.stringify({
            type: 'error',
            error: error.message
          })}\n\n`;
          controller.enqueue(encoder.encode(errorEvent));
        } finally {
          controller.close();
        }
      }
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      }
    }
  );
});
```

### Streaming Utilities

The SDK exports additional utilities for working with SSE streams:

#### `parseSSEStream`
Converts a `ReadableStream<Uint8Array>` (from SSE endpoints) into a typed `AsyncIterable<T>`. This is the primary utility for consuming streams from the SDK.

```typescript
import { parseSSEStream, type ExecEvent } from '@cloudflare/sandbox';

const stream = await sandbox.execStream('npm build');
for await (const event of parseSSEStream<ExecEvent>(stream)) {
  console.log(event);
}
```

#### `responseToAsyncIterable`
Converts a `Response` object with SSE content directly to `AsyncIterable<T>`. Useful when fetching from external SSE endpoints.

```typescript
import { responseToAsyncIterable, type LogEvent } from '@cloudflare/sandbox';

// Fetch from an external SSE endpoint
const response = await fetch('https://api.example.com/logs/stream', {
  headers: { 'Accept': 'text/event-stream' }
});

// Convert Response to typed AsyncIterable
for await (const event of responseToAsyncIterable<LogEvent>(response)) {
  console.log(`[${event.type}] ${event.data}`);
}
```

#### `asyncIterableToSSEStream`
Converts an `AsyncIterable<T>` into an SSE-formatted `ReadableStream<Uint8Array>`. Perfect for Worker endpoints that need to transform or filter events before sending to clients.

```typescript
import { getSandbox, parseSSEStream, asyncIterableToSSEStream, type LogEvent } from '@cloudflare/sandbox';

export async function handleFilteredLogs(request: Request, env: Env) {
  const sandbox = getSandbox(env.SANDBOX);
  
  // Custom async generator that filters logs
  async function* filterLogs() {
    const stream = await sandbox.streamProcessLogs('web-server');
    
    for await (const log of parseSSEStream<LogEvent>(stream)) {
      // Only forward error logs to the client
      if (log.type === 'stderr' || log.data.includes('ERROR')) {
        yield log;
      }
    }
  }

  // Convert filtered AsyncIterable back to SSE stream for the response
  const sseStream = asyncIterableToSSEStream(filterLogs());
  
  return new Response(sseStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    }
  });
}
```

**Advanced Example - Merging Multiple Streams:**
```typescript
async function* mergeBuilds(env: Env) {
  const sandbox1 = getSandbox(env.SANDBOX1);
  const sandbox2 = getSandbox(env.SANDBOX2);
  
  // Start builds in parallel
  const [stream1, stream2] = await Promise.all([
    sandbox1.execStream('npm run build:frontend'),
    sandbox2.execStream('npm run build:backend')
  ]);
  
  // Parse and merge events
  const frontend = parseSSEStream<ExecEvent>(stream1);
  const backend = parseSSEStream<ExecEvent>(stream2);
  
  // Merge with source identification
  for await (const event of frontend) {
    yield { ...event, source: 'frontend' };
  }
  for await (const event of backend) {
    yield { ...event, source: 'backend' };
  }
}

// Convert merged stream to SSE for client
const mergedSSE = asyncIterableToSSEStream(mergeBuilds(env));
```

### Cancellation Support

Both streaming methods support cancellation via AbortSignal:

```typescript
const controller = new AbortController();

// Cancel after 30 seconds
setTimeout(() => controller.abort(), 30000);

try {
  for await (const event of sandbox.execStream('long-running-task', {
    signal: controller.signal
  })) {
    // Process events
    if (shouldCancel(event)) {
      controller.abort();
    }
  }
} catch (error) {
  if (error.message.includes('aborted')) {
    console.log('Operation cancelled');
  }
}
```
