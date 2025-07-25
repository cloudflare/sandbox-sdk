<div align="center">
  <h1>📦 Cloudflare Sandbox SDK</h1>
  <h3><strong>Run sandboxed code environments on Cloudflare's edge network</strong></h3>
  <p>
    <a href="https://www.npmjs.com/package/@cloudflare/sandbox"><img src="https://img.shields.io/npm/v/@cloudflare/sandbox.svg" alt="npm version"></a>
    <a href="https://github.com/cloudflare/sandbox-sdk"><img src="https://img.shields.io/badge/status-experimental-orange.svg" alt="status"></a>
  </p>
</div>

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [✨ Overview](#overview)
- [🎯 Features](#features)
- [🚀 Quick Start](#quick-start)
  - [Installation](#installation)
  - [Basic Setup](#basic-setup)
- [📚 API Reference](#api-reference)
  - [Core Methods](#core-methods)
- [🌐 Port Forwarding](#port-forwarding)
  - [Utility Methods](#utility-methods)
- [💡 Examples](#examples)
  - [Run a Node.js App](#run-a-nodejs-app)
  - [Build and Test Code](#build-and-test-code)
  - [Interactive Development Environment](#interactive-development-environment)
  - [Expose Services with Preview URLs](#expose-services-with-preview-urls)
- [🏗️ Architecture](#architecture)
- [🛠️ Advanced Usage](#advanced-usage)
  - [AsyncIterable Streaming Support](#asynciterable-streaming-support)
  - [Session Management](#session-management)
- [🔍 Debugging](#debugging)
- [🚧 Known Limitations](#known-limitations)
- [🤝 Contributing](#contributing)
- [📄 License](#license)
- [🙌 Acknowledgments](#acknowledgments)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

<h2 id="overview">✨ Overview</h2>

The Cloudflare Sandbox SDK enables you to run isolated code environments directly on Cloudflare's edge network using Durable Objects and the Cloudflare Containers. Execute commands, manage files, run services, and expose them via public URLs - all within secure, sandboxed containers.

<h2 id="features">🎯 Features</h2>

- **🔒 Secure Isolation**: Each sandbox runs in its own container with full process isolation
- **⚡ Edge-Native**: Runs on Cloudflare's global network for low latency worldwide
- **📁 File System Access**: Read, write, and manage files within the sandbox
- **🔧 Command Execution**: Run any command or process inside the container
- **🌐 Preview URLs**: Expose services running in your sandbox via public URLs
- **🔄 Git Integration**: Clone repositories directly into sandboxes
- **🚀 Streaming Support**: Real-time output streaming for long-running commands
- **🎮 Session Management**: Maintain state across multiple operations

<h2 id="quick-start">🚀 Quick Start</h2>

### Installation

```bash
npm install @cloudflare/sandbox
```

### Basic Setup

1. **Create a Dockerfile** (temporary requirement, will be removed in future releases):

```dockerfile
FROM docker.io/cloudflare/sandbox:0.0.9

EXPOSE 3000

# Run the same command as the original image
CMD ["bun", "index.ts"]
```

2. **Configure wrangler.json**:

> **NOTE**: In an upcoming release, this step will be removed entirely and you can reference a single Docker image published by us directly in your wrangler configuration below.

```jsonc
{
  // ...
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile",
      "max_instances": 1
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

3. **Create your Worker**:

```typescript
import { getSandbox } from "@cloudflare/sandbox";

// Export the Sandbox class in your Worker
export { Sandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env) {
    const sandbox = getSandbox(env.Sandbox, "my-sandbox");

    // Execute a command
    const result = await sandbox.exec("echo 'Hello from the edge!'");
    return new Response(result.stdout);
  },
};
```

<h2 id="api-reference">📚 API Reference</h2>

### Core Methods

#### Command Execution

**`exec(command, options?)`** - Enhanced command execution that always returns results

```typescript
// Simple execution
const result = await sandbox.exec("npm install express");
console.log(result.stdout, result.exitCode);

// With streaming callbacks
const result = await sandbox.exec("npm run build", {
  stream: true,
  onOutput: (stream, data) => console.log(`[${stream}] ${data}`)
});
```

**`execStream(command, options?)`** - Dedicated streaming method returning SSE stream

```typescript
import { parseSSEStream, type ExecEvent } from '@cloudflare/sandbox';

const stream = await sandbox.execStream("npm run test");
for await (const event of parseSSEStream<ExecEvent>(stream)) {
  switch (event.type) {
    case 'stdout':
      console.log(`Test output: ${event.data}`);
      break;
    case 'complete':
      console.log(`Tests ${event.exitCode === 0 ? 'passed' : 'failed'}`);
      break;
  }
}
```

**`startProcess(command, options?)`** - Start background processes with lifecycle management

```typescript
const process = await sandbox.startProcess("node server.js");
console.log(`Started process ${process.id} with PID ${process.pid}`);

// Monitor the process
const logStream = await sandbox.streamProcessLogs(process.id);
for await (const log of parseSSEStream<LogEvent>(logStream)) {
  console.log(`Server: ${log.data}`);
}
```

#### `writeFile(path, content, options?)`

Write content to a file.

```typescript
await sandbox.writeFile("/app.js", "console.log('Hello!');");
```

#### `readFile(path, options?)`

Read a file from the sandbox.

```typescript
const file = await sandbox.readFile("/package.json");
console.log(file.content);
```

#### `gitCheckout(repoUrl, options?)`

Clone a git repository.

```typescript
await sandbox.gitCheckout("https://github.com/user/repo", {
  branch: "main",
  targetDir: "my-project",
});
```

#### Process Management

- `listProcesses()` - List all running processes
- `getProcess(id)` - Get detailed process status
- `killProcess(id, signal?)` - Terminate specific processes
- `killAllProcesses()` - Kill all processes
- `streamProcessLogs(id, options?)` - Stream logs from running processes
- `getProcessLogs(id)` - Get accumulated process output

#### File System Methods

- `writeFile(path, content, options?)` - Write content to a file
- `readFile(path, options?)` - Read a file from the sandbox
- `mkdir(path, options?)` - Create a directory
- `deleteFile(path)` - Delete a file
- `renameFile(oldPath, newPath)` - Rename a file
- `moveFile(sourcePath, destinationPath)` - Move a file
- `gitCheckout(repoUrl, options?)` - Clone git repositories

#### Network Methods

- `exposePort(port, options?)` - Expose a port and get a public URL
- `unexposePort(port)` - Remove port exposure
- `getExposedPorts()` - List all exposed ports with their URLs

<h2 id="port-forwarding">🌐 Port Forwarding</h2>

The SDK automatically handles preview URL routing for exposed ports. Just add one line to your worker:

```typescript
import { proxyToSandbox, getSandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request, env) {
    // Route requests to exposed container ports via their preview URLs
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    // Your custom routes here
    // ...
  },
};
```

When you expose a port, the SDK returns a preview URL that automatically routes to your service:

```typescript
const preview = await sandbox.exposePort(3000);
console.log(preview.url); // https://3000-sandbox-id.your-worker.dev
```

The SDK handles:

- Subdomain routing (`3000-sandbox-id.domain.com`) for both production and local development
- All localhost variants (127.0.0.1, ::1, etc.)
- Request forwarding with proper headers

> **Important for Local Development**: When developing locally with `wrangler dev`, you must explicitly expose ports in your Dockerfile using the `EXPOSE` instruction. This is **only required for local development** - in production, all container ports are automatically accessible.

```dockerfile
# In your Dockerfile (only needed for local dev)
FROM oven/bun:latest

# Expose the ports you'll be using
EXPOSE 3000  # For a web server
EXPOSE 8080  # For an API server
EXPOSE 3001  # For any additional services

# Your container setup...
```

Without the `EXPOSE` instruction in local development, you'll see this error:

```
connect(): Connection refused: container port not found. Make sure you exposed the port in your container definition.
```

For more details, see the [Cloudflare Containers local development guide](https://developers.cloudflare.com/containers/local-dev/#exposing-ports).

### Utility Methods

- `ping()` - Health check for the sandbox
- `containerFetch(request)` - Direct container communication

<h2 id="examples">💡 Examples</h2>

### Run a Node.js App

```typescript
const sandbox = getSandbox(env.Sandbox, "node-app");

// Write a simple Express server
await sandbox.writeFile(
  "/app.js",
  `
  const express = require('express');
  const app = express();

  app.get('/', (req, res) => {
    res.json({ message: 'Hello from Cloudflare!' });
  });

  app.listen(3000);
`
);

// Install dependencies and start the server
await sandbox.exec("npm init -y");
await sandbox.exec("npm install express");
const server = await sandbox.startProcess("node app.js");

// Expose it to the internet
const preview = await sandbox.exposePort(3000);
console.log(`API available at: ${preview.url}`);
```

### Build and Test Code

```typescript
const sandbox = getSandbox(env.Sandbox, "test-env");

// Clone a repository
await sandbox.gitCheckout("https://github.com/user/project");

// Run tests
const testResult = await sandbox.exec("npm test");

// Build the project
const buildResult = await sandbox.exec("npm run build");

return new Response(
  JSON.stringify({
    tests: testResult.exitCode === 0 ? "passed" : "failed",
    build: buildResult.exitCode === 0 ? "success" : "failed",
    output: testResult.stdout,
  })
);
```

### Interactive Development Environment

```typescript
// Create a development sandbox with hot reload
const sandbox = getSandbox(env.Sandbox, "dev-env");

// Set up the project
await sandbox.gitCheckout("https://github.com/user/my-app");
await sandbox.exec("npm install");

// Start dev server
const devServer = await sandbox.startProcess("npm run dev");

// Expose the dev server
const preview = await sandbox.exposePort(3000, { name: "dev-server" });

// Make changes and see them live!
await sandbox.writeFile("/src/App.jsx", updatedCode);
```

### Expose Services with Preview URLs

```typescript
// Create and start a web server
await sandbox.writeFile(
  "/server.js",
  `Bun.serve({
    port: 8080,
    fetch(req) {
      return new Response("Hello from sandbox!");
    }
  });`
);

const server = await sandbox.startProcess("bun run /server.js");

// Expose the port - returns a public URL
const preview = await sandbox.exposePort(8080);
console.log(`Service available at: ${preview.url}`);

// Note: Your Worker needs to handle preview URL routing.
// See the example in examples/basic/src/index.ts for the routing implementation.
```

<h2 id="architecture">🏗️ Architecture</h2>

The SDK leverages Cloudflare's infrastructure:

- **Durable Objects**: Manages sandbox lifecycle and state
- **Containers**: Provides isolated execution environments
- **Workers**: Handles HTTP routing and API interface
- **Edge Network**: Enables global distribution and low latency

<h2 id="advanced-usage">🛠️ Advanced Usage</h2>

### AsyncIterable Streaming Support

The SDK provides powerful streaming capabilities with typed AsyncIterable support:

```typescript
import { parseSSEStream, type ExecEvent } from '@cloudflare/sandbox';

// Stream command execution
const stream = await sandbox.execStream('npm run build');
for await (const event of parseSSEStream<ExecEvent>(stream)) {
  switch (event.type) {
    case 'start':
      console.log(`Build started: ${event.command}`);
      break;
    case 'stdout':
      console.log(`Build: ${event.data}`);
      break;
    case 'complete':
      console.log(`Exit code: ${event.exitCode}`);
      break;
    case 'error':
      console.error(`Error: ${event.error}`);
      break;
  }
}
```

#### Streaming Utilities

The SDK exports utilities for working with Server-Sent Event streams:

- **`parseSSEStream<T>(stream)`** - Convert ReadableStream to typed AsyncIterable
- **`responseToAsyncIterable<T>(response)`** - Convert SSE Response to AsyncIterable
- **`asyncIterableToSSEStream<T>(iterable)`** - Convert AsyncIterable back to SSE stream

#### Advanced Streaming Examples

**CI/CD Build System:**
```typescript
export async function runBuild(env: Env, buildId: string) {
  const sandbox = getSandbox(env.SANDBOX, buildId);
  const stream = await sandbox.execStream('npm run build');

  for await (const event of parseSSEStream<ExecEvent>(stream)) {
    switch (event.type) {
      case 'start':
        await env.BUILDS.put(buildId, { status: 'running' });
        break;
      case 'complete':
        await env.BUILDS.put(buildId, {
          status: event.exitCode === 0 ? 'success' : 'failed',
          exitCode: event.exitCode
        });
        break;
    }
  }
}
```

**System Monitoring:**
```typescript
const monitor = await sandbox.startProcess('tail -f /var/log/system.log');
const logStream = await sandbox.streamProcessLogs(monitor.id);

for await (const log of parseSSEStream<LogEvent>(logStream)) {
  if (log.type === 'stdout' && log.data.includes('ERROR')) {
    await env.ALERTS.send({
      severity: 'high',
      message: log.data,
      timestamp: log.timestamp
    });
  }
}
```

### Session Management

Maintain context across commands:

```typescript
const sessionId = crypto.randomUUID();

// Commands in the same session share working directory
await sandbox.exec("cd /app", { sessionId });
await sandbox.exec("npm install", { sessionId });
const app = await sandbox.startProcess("npm start", { sessionId });
```

<h2 id="debugging">🔍 Debugging</h2>

Enable verbose logging:

```typescript
const sandbox = getSandbox(env.Sandbox, "debug-sandbox");
sandbox.client.onCommandStart = (cmd, args) =>
  console.log(`Starting: ${cmd} ${args.join(" ")}`);
sandbox.client.onOutput = (stream, data) => console.log(`[${stream}] ${data}`);
sandbox.client.onCommandComplete = (success, code) =>
  console.log(`Completed: ${success} (${code})`);
```

<h2 id="known-limitations">🚧 Known Limitations</h2>

- Maximum container runtime is limited by Durable Object constraints
- WebSocket support for preview URLs coming soon
- Some system calls may be restricted in the container environment

<h2 id="contributing">🤝 Contributing</h2>

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

```bash
# Clone the repo
git clone https://github.com/cloudflare/sandbox-sdk
cd sandbox-sdk

# Install dependencies
npm install

# Run tests
npm test

# Build the project
npm run build
```

<h2 id="license">📄 License</h2>

[MIT License](LICENSE)

<h2 id="acknowledgments">🙌 Acknowledgments</h2>

Built with ❤️ by the Cloudflare team. Special thanks to all early adopters and contributors.

---

<div align="center">
  <p>
    <a href="https://github.com/cloudflare/sandbox-sdk/issues">Issues</a> •
    <a href="https://discord.gg/cloudflaredev">Discord</a> •
    <a href="https://twitter.com/CloudflareDev">Twitter</a>
  </p>
</div>
