# WebSocket Examples for Sandbox SDK

This example demonstrates how to use WebSockets with the Cloudflare Sandbox SDK by routing client connections to WebSocket servers running inside containers.

## Architecture

The WebSocket integration uses `connect(sandbox, request, port)` to route incoming WebSocket requests directly to WebSocket servers running inside the sandbox container:

```
Client ←WebSocket→ [Worker routes via connect()] → Container WebSocket Server
```

The pattern:
1. Start a WebSocket server inside the container (e.g., using Bun, Node.js, Python)
2. Use `connect(sandbox, request, port)` to route the incoming WebSocket upgrade request
3. Client communicates directly with the container's WebSocket server

## Setup

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Deploy to Cloudflare
npm run deploy
```

## Usage

### Local Development

1. Start the development server:
   ```bash
   npm run dev
   ```

2. Open your browser to `http://localhost:8787`

### WebSocket Endpoints

#### `/ws/echo`
Simple echo server that sends back any message it receives.

**Client Example:**
```javascript
const ws = new WebSocket('ws://localhost:8787/ws/echo?id=my-session');

ws.onmessage = (event) => {
  console.log('Received:', event.data);
};

ws.send('Hello!');
// Receives: "Hello!"
```

#### `/ws/broadcast`
Broadcasts messages to all connected clients (great for chat applications).

**Client Example:**
```javascript
const ws = new WebSocket('ws://localhost:8787/ws/broadcast?id=shared-room');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === 'join') {
    console.log(`User ${data.id} joined, ${data.count} online`);
  } else if (data.type === 'message') {
    console.log(`${data.from}: ${data.text}`);
  }
};

ws.send('Hello everyone!');
```

#### `/ws/json`
JSON RPC server that handles structured commands.

**Client Example:**
```javascript
const ws = new WebSocket('ws://localhost:8787/ws/json?id=my-session');

// Send ping
ws.send(JSON.stringify({ type: 'ping' }));

// Execute command in container
ws.send(JSON.stringify({
  type: 'exec',
  id: Date.now(),
  command: 'ls -la'
}));

// Get system info
ws.send(JSON.stringify({
  type: 'info',
  id: Date.now()
}));
```

## Implementation Pattern

Here's the basic pattern for creating a WebSocket endpoint:

```typescript
import { connect, getSandbox, Sandbox } from "@cloudflare/sandbox";

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const sandboxId = "my-sandbox";
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const port = 8080;

  // 1. Create WebSocket server script (using Bun)
  const serverScript = `
const port = ${port};

Bun.serve({
  port,
  fetch(req, server) {
    if (server.upgrade(req)) {
      return;
    }
    return new Response('Expected WebSocket', { status: 400 });
  },
  websocket: {
    message(ws, message) {
      // Handle incoming messages
      ws.send('Echo: ' + message);
    },
    open(ws) {
      console.log('Client connected');
    },
    close(ws) {
      console.log('Client disconnected');
    },
  },
});

console.log(\`WebSocket server listening on port \${port}\`);
`;

  // 2. Write server script to container
  await sandbox.writeFile('/tmp/ws-server.ts', serverScript);

  // 3. Start the server as a background process
  try {
    await sandbox.startProcess(\`bun run /tmp/ws-server.ts\`, {
      processId: \`ws-server-\${port}\`
    });
  } catch (error: any) {
    // Server might already be running
    if (!error.message?.includes('already exists')) {
      throw error;
    }
  }

  // 4. Give server time to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  // 5. Route WebSocket to container server
  return await connect(sandbox, request, port);
}
```

## Use Cases

### 1. Real-Time Communication
Build chat applications, collaborative tools, or live notifications:

```javascript
// All clients sharing the same sandbox ID see each other's messages
const ws = new WebSocket('wss://your-worker.workers.dev/ws/broadcast?id=room-123');

ws.send('Hello from client!');
// All clients in room-123 receive this message
```

### 2. Remote Command Execution
Execute commands in the container with real-time output:

```javascript
const ws = new WebSocket('wss://your-worker.workers.dev/ws/json');

ws.send(JSON.stringify({
  type: 'exec',
  command: 'python train.py',
  id: Date.now()
}));

// Receive execution results
ws.onmessage = (event) => {
  const result = JSON.parse(event.data);
  console.log('stdout:', result.stdout);
  console.log('exit code:', result.exitCode);
};
```

### 3. Interactive Services
Host any WebSocket-based service in the container:

- WebSocket terminals (xterm.js)
- Real-time data feeds
- Game servers
- Streaming APIs
- Custom protocols

## Server Technologies

You can run any WebSocket server inside the container:

### Bun (recommended - already in container)
```typescript
Bun.serve({
  port: 8080,
  websocket: {
    message(ws, message) {
      ws.send(message);
    }
  }
});
```

### Node.js
```javascript
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    ws.send(message);
  });
});
```

### Python
```python
import asyncio
import websockets

async def echo(websocket):
    async for message in websocket:
        await websocket.send(message)

start_server = websockets.serve(echo, "0.0.0.0", 8080)
asyncio.run(start_server)
```

## Advanced Patterns

### Multiple Ports
Run different WebSocket services on different ports:

```typescript
switch (pathname) {
  case "/ws/chat":
    return connect(sandbox, request, 8080); // Chat server
  case "/ws/terminal":
    return connect(sandbox, request, 8081); // Terminal
  case "/ws/game":
    return connect(sandbox, request, 8082); // Game server
}
```

### Shared vs Isolated Sandboxes
```typescript
// Shared sandbox - all clients connect to same server
const sandbox = getSandbox(env.Sandbox, "shared-room");

// Isolated sandbox - each user gets their own server
const sandbox = getSandbox(env.Sandbox, userId);
```

### Connection Management
```typescript
// Check if server is running before connecting
const processes = await sandbox.listProcesses();
const serverRunning = processes.some(p => p.id === 'ws-server-8080');

if (!serverRunning) {
  // Start server
  await sandbox.startProcess('bun run /tmp/ws-server.ts', {
    processId: 'ws-server-8080'
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
}

return connect(sandbox, request, 8080);
```

## Best Practices

### 1. Process Management
Use named process IDs to avoid starting duplicate servers:

```typescript
try {
  await sandbox.startProcess('bun run /tmp/server.ts', {
    processId: 'ws-server-8080' // Named ID prevents duplicates
  });
} catch (error: any) {
  if (!error.message?.includes('already exists')) {
    throw error;
  }
}
```

### 2. Startup Delays
Give servers time to bind to ports before routing connections:

```typescript
await sandbox.startProcess('bun run /tmp/server.ts');
await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
return connect(sandbox, request, port);
```

### 3. Error Handling
Handle connection failures gracefully:

```typescript
try {
  return await connect(sandbox, request, port);
} catch (error) {
  console.error('Failed to connect:', error);
  return new Response('WebSocket server unavailable', { status: 503 });
}
```

### 4. Client Reconnection
Implement reconnection logic in clients:

```javascript
let reconnectAttempts = 0;
const maxAttempts = 5;

function connect() {
  const ws = new WebSocket(url);

  ws.onclose = () => {
    if (reconnectAttempts < maxAttempts) {
      reconnectAttempts++;
      setTimeout(connect, 1000 * reconnectAttempts);
    }
  };

  ws.onopen = () => {
    reconnectAttempts = 0;
  };
}
```

### 5. Message Validation
Always validate incoming messages in your container server:

```typescript
websocket: {
  message(ws, message) {
    try {
      const data = JSON.parse(message.toString());

      if (!data.type || typeof data.type !== 'string') {
        ws.send(JSON.stringify({ error: 'Invalid message format' }));
        return;
      }

      // Handle valid message
    } catch (error) {
      ws.send(JSON.stringify({ error: 'Invalid JSON' }));
    }
  }
}
```

## Security Considerations

### Input Validation
Always validate commands and inputs in your container server:

```typescript
case 'exec':
  // Don't trust user input - validate and sanitize
  const command = data.command;
  if (!isValidCommand(command)) {
    return { error: 'Invalid command' };
  }
  // Execute safely
  break;
```

### Rate Limiting
Implement rate limiting in your container server:

```typescript
const rateLimits = new Map();

websocket: {
  message(ws, message) {
    const clientId = ws.data.id;
    const now = Date.now();

    const lastMessage = rateLimits.get(clientId) || 0;
    if (now - lastMessage < 100) { // Max 10 msg/sec
      ws.send(JSON.stringify({ error: 'Rate limit exceeded' }));
      return;
    }

    rateLimits.set(clientId, now);
    // Handle message
  }
}
```

### Authentication
Add authentication before routing to WebSocket:

```typescript
async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!await verifyToken(token)) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Route to WebSocket
  return connect(sandbox, request, port);
}
```

## Troubleshooting

### Connection Refused
- Ensure server is running: check with `sandbox.listProcesses()`
- Verify port is correct
- Wait longer after starting server (increase delay)

### Messages Not Received
- Check WebSocket upgrade header is present
- Verify message format (text vs binary)
- Ensure server is calling `server.upgrade(req)` in Bun

### Server Not Starting
- Check for port conflicts (use different ports for each service)
- Verify server script has no syntax errors
- Check container logs for error messages

## Performance Tips

1. **Reuse Servers**: Use named process IDs to avoid restarting servers on each connection
2. **Connection Pooling**: Share sandbox instances across multiple clients using the same sandbox ID
3. **Binary Messages**: Use binary frames for large data transfers to reduce overhead
4. **Batch Updates**: Send multiple updates in a single message when possible

## Further Reading

- [Cloudflare Workers WebSocket Documentation](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
- [Bun WebSocket API](https://bun.sh/docs/api/websockets)
- [WebSocket RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455)

## License

MIT
