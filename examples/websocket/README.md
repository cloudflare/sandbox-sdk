# WebSocket Examples for Sandbox SDK

This example demonstrates how to use WebSockets with the Cloudflare Sandbox SDK for real-time, bidirectional communication between clients and sandboxed containers.

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
Basic echo server with sandbox command execution.

**Client Message Format:**
```json
{
  "type": "echo",
  "data": "Hello, sandbox!"
}
```

```json
{
  "type": "execute",
  "command": "python --version"
}
```

**Server Response Format:**
```json
{
  "type": "echo",
  "data": "Hello, sandbox!",
  "timestamp": 1234567890
}
```

```json
{
  "type": "result",
  "stdout": "Python 3.11.0\n",
  "stderr": "",
  "exitCode": 0
}
```

#### `/ws/code`
Real-time code execution with streaming output.

**Client Message Format:**
```json
{
  "type": "execute",
  "code": "print('Hello from Python')",
  "language": "python",
  "sessionId": "session-123"
}
```

**Server Response Format:**
```json
{
  "type": "stdout",
  "data": "Hello from Python\n",
  "sessionId": "session-123"
}
```

```json
{
  "type": "result",
  "sessionId": "session-123",
  "results": [...],
  "error": null,
  "logs": { "stdout": [...], "stderr": [...] }
}
```

#### `/ws/process`
Stream output from long-running processes.

**Client Message Format:**
```json
{
  "type": "start",
  "command": "ping",
  "args": ["-c", "5", "cloudflare.com"]
}
```

```json
{
  "type": "kill"
}
```

**Server Response Format:**
```json
{
  "type": "started",
  "pid": 12345
}
```

```json
{
  "type": "stdout",
  "data": "PING cloudflare.com...\n",
  "pid": 12345
}
```

```json
{
  "type": "completed",
  "pid": 12345
}
```

#### `/ws/terminal`
Interactive terminal session.

**Client Message Format:**
```
ls -la\n
```

```json
{
  "type": "resize",
  "rows": 24,
  "cols": 80
}
```

**Server Response:**
Raw terminal output or JSON status messages.

## Code Examples

### JavaScript Client

```javascript
// Connect to echo server
const ws = new WebSocket('wss://your-worker.workers.dev/ws/echo?id=my-session');

ws.onopen = () => {
  console.log('Connected');

  // Send echo message
  ws.send(JSON.stringify({
    type: 'echo',
    data: 'Hello!'
  }));

  // Execute command
  ws.send(JSON.stringify({
    type: 'execute',
    command: 'python -c "print(2+2)"'
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data);
};

ws.onclose = () => {
  console.log('Disconnected');
};
```

### Python Client

```python
import asyncio
import websockets
import json

async def execute_code():
    uri = "wss://your-worker.workers.dev/ws/code?id=my-session"

    async with websockets.connect(uri) as websocket:
        # Send code to execute
        await websocket.send(json.dumps({
            "type": "execute",
            "code": """
import time
for i in range(5):
    print(f'Count: {i}')
    time.sleep(0.5)
            """,
            "sessionId": "test-1"
        }))

        # Receive streaming output
        while True:
            try:
                message = await websocket.recv()
                data = json.loads(message)

                if data['type'] == 'stdout':
                    print(data['data'], end='')
                elif data['type'] == 'result':
                    print('Execution complete')
                    break
            except websockets.exceptions.ConnectionClosed:
                break

asyncio.run(execute_code())
```

### Node.js Client

```javascript
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8787/ws/process?id=node-client');

ws.on('open', () => {
  console.log('Connected to process streamer');

  // Start a long-running process
  ws.send(JSON.stringify({
    type: 'start',
    command: 'python',
    args: ['-u', 'long_script.py']
  }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data);

  if (message.type === 'stdout' || message.type === 'stderr') {
    process.stdout.write(message.data);
  } else if (message.type === 'completed') {
    console.log('Process completed');
    ws.close();
  }
});

// Kill process after 10 seconds
setTimeout(() => {
  ws.send(JSON.stringify({ type: 'kill' }));
}, 10000);
```

## Use Cases

### 1. Real-Time Data Analysis

Stream data processing results as they're computed:

```javascript
const ws = new WebSocket('wss://your-worker.workers.dev/ws/code');

ws.send(JSON.stringify({
  type: 'execute',
  code: `
import pandas as pd
import time

for chunk in pd.read_csv('large_file.csv', chunksize=1000):
    result = chunk.describe()
    print(result)
    time.sleep(0.1)
  `,
  sessionId: 'analysis-1'
}));
```

### 2. AI Code Agent

AI agent that generates and executes code with real-time feedback:

```javascript
// Generate code with AI
const code = await generateWithAI(userPrompt);

// Execute and stream results
ws.send(JSON.stringify({
  type: 'execute',
  code: code,
  sessionId: 'ai-agent-1'
}));

// User sees live output as code runs
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'stdout') {
    updateUI(data.data);
  }
};
```

### 3. Collaborative IDE

Multiple users share a sandbox:

```javascript
// User A's connection
const wsA = new WebSocket('wss://your-worker.workers.dev/ws/code?id=shared-123');

// User B's connection (same sandbox)
const wsB = new WebSocket('wss://your-worker.workers.dev/ws/code?id=shared-123');

// Both see the same execution results
wsA.send(JSON.stringify({
  type: 'execute',
  code: 'x = 42'
}));

wsB.send(JSON.stringify({
  type: 'execute',
  code: 'print(x)'  // Prints 42 from shared context
}));
```

### 4. Live Monitoring

Monitor sandbox metrics and logs:

```javascript
const ws = new WebSocket('wss://your-worker.workers.dev/ws/process');

ws.send(JSON.stringify({
  type: 'start',
  command: 'top',
  args: ['-b', '-d', '1']  // Update every second
}));

// Real-time system monitoring
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'stdout') {
    updateMonitoringDashboard(data.data);
  }
};
```

## Best Practices

### 1. Error Handling

Always handle errors gracefully:

```javascript
ws.onerror = (error) => {
  console.error('WebSocket error:', error);
  // Attempt reconnection
  setTimeout(() => reconnect(), 1000);
};

ws.onclose = (event) => {
  if (event.code !== 1000) {  // Not a normal closure
    console.log('Unexpected close, reconnecting...');
    reconnect();
  }
};
```

### 2. Heartbeat/Ping-Pong

Keep connections alive:

```javascript
let pingInterval;

ws.onopen = () => {
  // Send ping every 30 seconds
  pingInterval = setInterval(() => {
    ws.send(JSON.stringify({ type: 'ping' }));
  }, 30000);
};

ws.onclose = () => {
  clearInterval(pingInterval);
};
```

### 3. Message Buffering

Buffer messages when disconnected:

```javascript
const messageQueue = [];
let isConnected = false;

function sendMessage(msg) {
  if (isConnected) {
    ws.send(JSON.stringify(msg));
  } else {
    messageQueue.push(msg);
  }
}

ws.onopen = () => {
  isConnected = true;
  // Flush queue
  while (messageQueue.length > 0) {
    ws.send(JSON.stringify(messageQueue.shift()));
  }
};
```

### 4. Rate Limiting

Prevent overwhelming the sandbox:

```javascript
class RateLimitedWebSocket {
  constructor(url, messagesPerSecond = 10) {
    this.ws = new WebSocket(url);
    this.queue = [];
    this.limit = messagesPerSecond;
    this.interval = 1000 / messagesPerSecond;

    setInterval(() => this.processQueue(), this.interval);
  }

  send(message) {
    this.queue.push(message);
  }

  processQueue() {
    if (this.queue.length > 0 && this.ws.readyState === 1) {
      this.ws.send(this.queue.shift());
    }
  }
}
```

## Security Considerations

### Authentication

Add authentication to WebSocket connections:

```typescript
// Server side
const token = new URL(request.url).searchParams.get('token');
if (!token || !(await verifyToken(token))) {
  return new Response('Unauthorized', { status: 401 });
}
```

### Input Validation

Always validate and sanitize inputs:

```typescript
server.addEventListener('message', async (event) => {
  const message = JSON.parse(event.data);

  // Validate message structure
  if (!message.type || typeof message.type !== 'string') {
    server.send(JSON.stringify({ type: 'error', message: 'Invalid format' }));
    return;
  }

  // Prevent command injection
  if (message.command && /[;&|`$]/.test(message.command)) {
    server.send(JSON.stringify({ type: 'error', message: 'Invalid characters' }));
    return;
  }
});
```

### Resource Limits

Set limits on connections and execution time:

```typescript
const MAX_CONNECTIONS = 100;
const MAX_EXECUTION_TIME = 60000; // 60 seconds

if (activeConnections.size >= MAX_CONNECTIONS) {
  server.close(1008, 'Connection limit reached');
  return;
}

// Set execution timeout
const timeout = setTimeout(() => {
  server.close(1000, 'Execution timeout');
}, MAX_EXECUTION_TIME);
```

## Troubleshooting

### Connection Refused

Check that WebSocket upgrades are properly handled:
- Verify `Upgrade: websocket` header is present
- Ensure status code 101 is returned
- Check that WebSocketPair is created correctly

### Messages Not Received

Ensure proper message formatting:
- Use `JSON.stringify()` for structured data
- Check for serialization errors
- Verify server is calling `server.accept()`

### Connection Drops

Implement reconnection logic:
```javascript
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

function connect() {
  const ws = new WebSocket(url);

  ws.onclose = () => {
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      setTimeout(connect, 1000 * reconnectAttempts);
    }
  };

  ws.onopen = () => {
    reconnectAttempts = 0;
  };
}
```

## Performance Tips

1. **Use Binary Frames** for large data transfers
2. **Buffer Small Messages** to reduce syscalls
3. **Implement Backpressure** to handle slow clients
4. **Use Compression** for text-heavy streams
5. **Batch Updates** when sending frequent small updates

## Further Reading

- [Cloudflare Workers WebSocket Documentation](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
- [Sandbox SDK Documentation](https://developers.cloudflare.com/sandbox/)
- [WebSocket RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455)

## License

MIT
