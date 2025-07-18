<div align="center">
  <h1>📦 Cloudflare Sandbox SDK</h1>
  <h3><strong>Run sandboxed code environments on Cloudflare's edge network</strong></h3>
  <p>
    <a href="https://www.npmjs.com/package/@cloudflare/sandbox"><img src="https://img.shields.io/npm/v/@cloudflare/sandbox.svg" alt="npm version"></a>
    <a href="https://github.com/cloudflare/sandbox-sdk"><img src="https://img.shields.io/badge/status-experimental-orange.svg" alt="status"></a>
  </p>
</div>

<div align="center">
  <a href="#overview">Overview</a> •
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#api-reference">API</a> •
  <a href="#examples">Examples</a> •
  <a href="#contributing">Contributing</a>
</div>

## ✨ Overview

The Cloudflare Sandbox SDK enables you to run isolated code environments directly on Cloudflare's edge network using Durable Objects and the Cloudflare Containers. Execute commands, manage files, run services, and expose them via public URLs - all within secure, sandboxed containers.

## 🎯 Features

- **🔒 Secure Isolation**: Each sandbox runs in its own container with full process isolation
- **⚡ Edge-Native**: Runs on Cloudflare's global network for low latency worldwide
- **📁 File System Access**: Read, write, and manage files within the sandbox
- **🔧 Command Execution**: Run any command or process inside the container
- **🌐 Preview URLs**: Expose services running in your sandbox via public URLs
- **🔄 Git Integration**: Clone repositories directly into sandboxes
- **🚀 Streaming Support**: Real-time output streaming for long-running commands
- **🎮 Session Management**: Maintain state across multiple operations

## 🚀 Quick Start

### Prerequisites

- Node.js ≥ 18
- Cloudflare account with [Containers platform access](https://blog.cloudflare.com/cloudflare-containers-coming-2025/)
- Wrangler CLI installed (`npm install -g wrangler`)

### Installation

```bash
npm install @cloudflare/sandbox
```

### Basic Setup

1. **Create a Dockerfile** (temporary requirement, will be removed in future releases):

```dockerfile
FROM docker.io/ghostwriternr/cloudflare-sandbox:0.0.5
# If building your project on arm64, use:
# FROM docker.io/ghostwriternr/cloudflare-sandbox-arm:0.0.5

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
    const result = await sandbox.exec("echo", ["Hello from the edge!"]);
    return new Response(result.stdout);
  },
};
```

## 📚 API Reference

### Core Methods

#### `exec(command, args, options?)`
Execute a command in the sandbox.

```typescript
const result = await sandbox.exec("npm", ["install", "express"]);
console.log(result.stdout);
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
  targetDir: "my-project"
});
```

### File System Methods

- `writeFile(path, content, options?)` - Write content to a file
- `readFile(path, options?)` - Read a file from the sandbox
- `mkdir(path, options?)` - Create a directory
- `deleteFile(path)` - Delete a file
- `renameFile(oldPath, newPath)` - Rename a file
- `moveFile(sourcePath, destinationPath)` - Move a file

### Network Methods

- `exposePort(port, options?)` - Expose a port and get a public URL
- `unexposePort(port)` - Remove port exposure
- `getExposedPorts()` - List all exposed ports with their URLs

## 🌐 Port Forwarding

The SDK automatically handles preview URL routing for exposed ports. Just add one line to your worker:

```typescript
import { handleSandboxRequest, getSandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request, env) {
    // This handles all preview URL routing automatically
    const sandboxResponse = await handleSandboxRequest(request, env);
    if (sandboxResponse) return sandboxResponse;

    // Your custom routes here
    // ...
  }
};
```

When you expose a port, the SDK returns a preview URL that automatically routes to your service:

```typescript
const preview = await sandbox.exposePort(3000);
console.log(preview.url); // https://3000-sandbox-id.your-worker.dev
```

The SDK handles:
- Production subdomain routing (`3000-sandbox-id.domain.com`)
- Local development routing (`localhost:8787/preview/3000/sandbox-id`)
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

## 💡 Examples

### Run a Node.js App

```typescript
const sandbox = getSandbox(env.Sandbox, "node-app");

// Write a simple Express server
await sandbox.writeFile("/app.js", `
  const express = require('express');
  const app = express();

  app.get('/', (req, res) => {
    res.json({ message: 'Hello from Cloudflare!' });
  });

  app.listen(3000);
`);

// Install dependencies and start the server
await sandbox.exec("npm", ["init", "-y"]);
await sandbox.exec("npm", ["install", "express"]);
await sandbox.exec("node", ["app.js"]);

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
const testResult = await sandbox.exec("npm", ["test"]);

// Build the project
const buildResult = await sandbox.exec("npm", ["run", "build"]);

return new Response(JSON.stringify({
  tests: testResult.exitCode === 0 ? "passed" : "failed",
  build: buildResult.exitCode === 0 ? "success" : "failed",
  output: testResult.stdout
}));
```

### Interactive Development Environment

```typescript
// Create a development sandbox with hot reload
const sandbox = getSandbox(env.Sandbox, "dev-env");

// Set up the project
await sandbox.gitCheckout("https://github.com/user/my-app");
await sandbox.exec("npm", ["install"]);

// Start dev server
await sandbox.exec("npm", ["run", "dev"]);

// Expose the dev server
const preview = await sandbox.exposePort(3000, { name: "dev-server" });

// Make changes and see them live!
await sandbox.writeFile("/src/App.jsx", updatedCode);
```

### Expose Services with Preview URLs

```typescript
// Create and start a web server
await sandbox.writeFile("/server.js", `
  Bun.serve({
    port: 8080,
    fetch(req) {
      return new Response("Hello from sandbox!");
    }
  });
`);

await sandbox.exec("bun", ["run", "/server.js"]);

// Expose the port - returns a public URL
const preview = await sandbox.exposePort(8080);
console.log(`Service available at: ${preview.url}`);

// Note: Your Worker needs to handle preview URL routing.
// See the example in examples/basic/src/index.ts for the routing implementation.
```

## 🏗️ Architecture

The SDK leverages Cloudflare's infrastructure:

- **Durable Objects**: Manages sandbox lifecycle and state
- **Containers**: Provides isolated execution environments
- **Workers**: Handles HTTP routing and API interface
- **Edge Network**: Enables global distribution and low latency

## 🛠️ Advanced Usage

### Streaming Output

For long-running commands, use streaming:

```typescript
const response = await sandbox.exec("npm", ["install"], { stream: true });

// Process the stream
const reader = response.body.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(new TextDecoder().decode(value));
}
```

### Session Management

Maintain context across commands:

```typescript
const sessionId = crypto.randomUUID();

// Commands in the same session share working directory
await sandbox.exec("cd", ["/app"], { sessionId });
await sandbox.exec("npm", ["install"], { sessionId });
await sandbox.exec("npm", ["start"], { sessionId });
```

## 🔍 Debugging

Enable verbose logging:

```typescript
const sandbox = getSandbox(env.Sandbox, "debug-sandbox");
sandbox.client.onCommandStart = (cmd, args) => console.log(`Starting: ${cmd} ${args.join(' ')}`);
sandbox.client.onOutput = (stream, data) => console.log(`[${stream}] ${data}`);
sandbox.client.onCommandComplete = (success, code) => console.log(`Completed: ${success} (${code})`);
```

## 🚧 Known Limitations

- Containers require early access to Cloudflare's platform
- Maximum container runtime is limited by Durable Object constraints
- WebSocket support for preview URLs coming soon
- Some system calls may be restricted in the container environment

## 🤝 Contributing

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

## 📄 License

[MIT License](LICENSE) - feel free to use this in your projects!

## 🙌 Acknowledgments

Built with ❤️ by the Cloudflare team. Special thanks to all early adopters and contributors who are helping shape the future of edge computing.

---

<div align="center">
  <p>
    <a href="https://developers.cloudflare.com">Docs</a> •
    <a href="https://github.com/cloudflare/sandbox-sdk/issues">Issues</a> •
    <a href="https://discord.gg/cloudflaredev">Discord</a> •
    <a href="https://twitter.com/CloudflareDev">Twitter</a>
  </p>
</div>