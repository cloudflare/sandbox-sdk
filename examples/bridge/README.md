# Sandbox Bridge Example

This example demonstrates how to create an HTTP bridge that exposes the Sandbox SDK API, allowing access from any platform via HTTP requests.

## What is the Bridge?

The bridge is a Cloudflare Worker that:

1. **Authenticates** requests using Bearer token authentication
2. **Routes** HTTP requests to the appropriate Sandbox operations
3. **Handles CORS** for browser-based clients
4. **Exposes** all sandbox capabilities via REST API

This enables you to use the Sandbox SDK from:

- **Python** applications
- **Go** services
- **Browser** JavaScript (with proper CORS)
- **Any HTTP client** in any language

## Setup

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Set your API key:**

   ```bash
   wrangler secret put SANDBOX_API_KEY
   # Enter a secure random key when prompted
   ```

3. **Deploy the bridge:**

   ```bash
   npm run deploy
   ```

## Usage with Client SDK

Once deployed, use the client SDK to connect:

```typescript
import { getSandbox } from '@cloudflare/sandbox/client';

const sandbox = getSandbox('my-project', {
  baseUrl: 'https://your-bridge.workers.dev',
  apiKey: 'your-api-key'
});

// Execute commands
const result = await sandbox.exec('echo "Hello from bridge!"');
console.log(result.stdout);

// Work with files
await sandbox.writeFile('/workspace/test.txt', 'Hello, World!');
const file = await sandbox.readFile('/workspace/test.txt');

// Run Python code
const code = await sandbox.runCode('print(2 + 2)');
console.log(code.logs.stdout);
```

## API Reference

The bridge exposes the following endpoints:

### Command Execution

- `POST /api/sandbox/{id}/exec` - Execute a command
- `POST /api/sandbox/{id}/exec/stream` - Stream command output (SSE)

### File Operations

- `POST /api/sandbox/{id}/files/write` - Write a file
- `GET /api/sandbox/{id}/files/read?path=...` - Read a file
- `POST /api/sandbox/{id}/files/mkdir` - Create directory
- `POST /api/sandbox/{id}/files/delete` - Delete a file
- `GET /api/sandbox/{id}/files/list?path=...` - List directory
- `GET /api/sandbox/{id}/files/exists?path=...` - Check if file exists

### Process Management

- `POST /api/sandbox/{id}/processes/start` - Start background process
- `GET /api/sandbox/{id}/processes` - List processes
- `GET /api/sandbox/{id}/processes/{pid}` - Get process info
- `DELETE /api/sandbox/{id}/processes/{pid}` - Kill process

### Git Operations

- `POST /api/sandbox/{id}/git/checkout` - Clone repository

### Code Interpreter

- `POST /api/sandbox/{id}/code/run` - Run code
- `POST /api/sandbox/{id}/code/run/stream` - Stream code execution
- `POST /api/sandbox/{id}/code/contexts` - Create code context
- `GET /api/sandbox/{id}/code/contexts` - List contexts
- `DELETE /api/sandbox/{id}/code/contexts/{id}` - Delete context

### Session Management

- `POST /api/sandbox/{id}/sessions` - Create session
- `DELETE /api/sandbox/{id}/sessions/{id}` - Delete session

## Security

- All requests must include `Authorization: Bearer <your-api-key>`
- The API key should be stored securely using `wrangler secret`
- CORS is enabled for browser clients
