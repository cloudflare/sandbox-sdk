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
- [🧪 Code Interpreter](#code-interpreter)
  - [Code Execution](#code-execution)
  - [Rich Outputs](#rich-outputs)
  - [Output Formats](#output-formats)
- [🌐 Port Forwarding](#port-forwarding)
  - [Utility Methods](#utility-methods)
- [💡 Examples](#examples)
  - [Run a Node.js App](#run-a-nodejs-app)
  - [Build and Test Code](#build-and-test-code)
  - [Interactive Development Environment](#interactive-development-environment)
  - [Expose Services with Preview URLs](#expose-services-with-preview-urls)
  - [Data Analysis with Code Interpreter](#data-analysis-with-code-interpreter)
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
- **🧪 Code Interpreter**: Execute Python and JavaScript with rich outputs (charts, tables, formatted data)
- **📊 Multi-Language Support**: Persistent execution contexts for Python and JavaScript/TypeScript
- **🎨 Rich MIME Types**: Automatic processing of images, HTML, charts, and structured data

<h2 id="quick-start">🚀 Quick Start</h2>

### Installation

```bash
npm install @cloudflare/sandbox
```

### Basic Setup

1. **Create a Dockerfile** (temporary requirement, will be removed in future releases):

```dockerfile
FROM docker.io/cloudflare/sandbox:0.3.1

# Expose the ports you want to expose
EXPOSE 3000
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
await sandbox.writeFile("/workspace/app.js", "console.log('Hello!');");
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

#### `setEnvVars(envVars)`

Set environment variables dynamically in the sandbox.

> **Important**: This method must be called immediately after `getSandbox()` and before any other operations. Once a sandbox instance starts up, environment variables cannot be changed
for that instance.

```typescript
const sandbox = getSandbox(env.Sandbox, "my-sandbox");

// Set environment variables FIRST, before any other operations
await sandbox.setEnvVars({
  NODE_ENV: "production",
  API_KEY: "your-api-key",
  DATABASE_URL: "postgresql://localhost:5432/mydb"
});

// Now you can run commands - environment variables are available
const result = await sandbox.exec("echo $NODE_ENV");
console.log(result.stdout); // "production"
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

#### Session Methods

- `createSession(options)` - Create an isolated execution session
  - `name`: Session identifier
  - `env`: Environment variables for this session
  - `cwd`: Working directory
  - `isolation`: Enable PID namespace isolation (requires CAP_SYS_ADMIN)

<h2 id="code-interpreter">🧪 Code Interpreter</h2>

The Sandbox SDK includes powerful code interpreter capabilities, allowing you to execute Python and JavaScript code with rich outputs including charts, tables, and formatted data.

### Code Execution

#### `createCodeContext(options?)`

Creates a new code execution context with persistent state.

```typescript
// Create a Python context
const pythonCtx = await sandbox.createCodeContext({ language: 'python' });

// Create a JavaScript context
const jsCtx = await sandbox.createCodeContext({ language: 'javascript' });
```

**Options:**
- `language`: Programming language (`'python'` | `'javascript'` | `'typescript'`)
- `cwd`: Working directory (default: `/workspace`)
- `envVars`: Environment variables for the context

#### `runCode(code, options?)`

Executes code with optional streaming callbacks.

```typescript
// Simple execution
const execution = await sandbox.runCode('print("Hello World")', { 
  context: pythonCtx 
});

// With streaming callbacks
await sandbox.runCode(`
for i in range(5):
    print(f"Step {i}")
    time.sleep(1)
`, { 
  context: pythonCtx,
  onStdout: (output) => console.log('Real-time:', output.text),
  onResult: (result) => console.log('Result:', result)
});
```

**Options:**
- `context`: Context to run the code in
- `language`: Language if no context provided
- `onStdout`: Callback for stdout output
- `onStderr`: Callback for stderr output
- `onResult`: Callback for execution results
- `onError`: Callback for errors

#### `runCodeStream(code, options?)`

Returns a streaming response for real-time processing.

```typescript
const stream = await sandbox.runCodeStream('import time; [print(i) for i in range(10)]');
// Process the stream as needed
```

### Rich Outputs

The code interpreter automatically detects and processes various output types:

```typescript
// Data visualization
const execution = await sandbox.runCode(`
import matplotlib.pyplot as plt
import numpy as np

x = np.linspace(0, 10, 100)
y = np.sin(x)
plt.plot(x, y)
plt.title('Sine Wave')
plt.show()
`, { 
  context: pythonCtx,
  onResult: (result) => {
    if (result.png) {
      // Base64 encoded PNG image
      console.log('Chart generated!');
    }
  }
});

// HTML tables with pandas
const tableExecution = await sandbox.runCode(`
import pandas as pd
df = pd.DataFrame({
    'name': ['Alice', 'Bob', 'Charlie'],
    'score': [92, 88, 95]
})
df
`, { context: pythonCtx });

// Access HTML table in execution.results[0].html
```

### Output Formats

Results can include multiple formats:
- `text`: Plain text representation
- `html`: HTML (often pandas DataFrames)
- `png`/`jpeg`: Base64 encoded images
- `svg`: Vector graphics
- `json`: Structured data
- `chart`: Parsed chart information

Check available formats with `result.formats()`.

#### Additional Code Interpreter Methods

- `listCodeContexts()` - List all active code contexts
- `deleteCodeContext(contextId)` - Delete a specific context

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
FROM docker.io/cloudflare/sandbox:0.1.3

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
  "/workspace/app.js",
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

### Data Analysis with Code Interpreter

```typescript
const sandbox = getSandbox(env.Sandbox, "analysis");

// Create a Python context for data analysis
const pythonCtx = await sandbox.createCodeContext({ language: 'python' });

// Load and analyze data
const analysis = await sandbox.runCode(`
import pandas as pd
import matplotlib.pyplot as plt

# Create sample data
data = {
    'Month': ['Jan', 'Feb', 'Mar', 'Apr', 'May'],
    'Sales': [10000, 12000, 15000, 14000, 18000],
    'Profit': [2000, 2500, 3200, 2800, 4000]
}
df = pd.DataFrame(data)

# Display summary statistics
print("Sales Summary:")
print(df.describe())

# Create visualization
plt.figure(figsize=(10, 6))
plt.subplot(1, 2, 1)
plt.bar(df['Month'], df['Sales'])
plt.title('Monthly Sales')
plt.xlabel('Month')
plt.ylabel('Sales ($)')

plt.subplot(1, 2, 2)
plt.plot(df['Month'], df['Profit'], marker='o', color='green')
plt.title('Monthly Profit')
plt.xlabel('Month')
plt.ylabel('Profit ($)')

plt.tight_layout()
plt.show()

# Return the data as JSON
df.to_dict('records')
`, { 
  context: pythonCtx,
  onResult: (result) => {
    if (result.png) {
      // Handle the chart image
      console.log('Chart generated:', result.png.substring(0, 50) + '...');
    }
    if (result.json) {
      // Handle the structured data
      console.log('Data:', result.json);
    }
  }
});

// Multi-language workflow: Process in Python, analyze in JavaScript
await sandbox.runCode(`
# Save processed data
df.to_json('/tmp/sales_data.json', orient='records')
`, { context: pythonCtx });

const jsCtx = await sandbox.createCodeContext({ language: 'javascript' });
const jsAnalysis = await sandbox.runCode(`
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/sales_data.json', 'utf8'));

// Calculate growth rate
const growth = data.map((curr, idx) => {
  if (idx === 0) return { ...curr, growth: 0 };
  const prev = data[idx - 1];
  return {
    ...curr,
    growth: ((curr.Sales - prev.Sales) / prev.Sales * 100).toFixed(2) + '%'
  };
});

console.log('Growth Analysis:', growth);
growth;
`, { context: jsCtx });
```

<h2 id="architecture">🏗️ Architecture</h2>

The SDK leverages Cloudflare's infrastructure:

- **Durable Objects**: Manages sandbox lifecycle and state
- **Containers**: Provides isolated execution environments with Jupyter kernels
- **Workers**: Handles HTTP routing and API interface
- **Edge Network**: Enables global distribution and low latency
- **Jupyter Integration**: Python (IPython) and JavaScript (TSLab) kernels for code execution
- **MIME Processing**: Automatic detection and handling of rich output formats

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

The SDK provides two approaches for managing execution context:

#### Implicit Sessions (Recommended)

Each sandbox maintains its own persistent session automatically:

```typescript
const sandbox = getSandbox(env.Sandbox, "my-app");

// These commands share state (pwd, env vars, etc.)
await sandbox.exec("cd /app");
await sandbox.exec("pwd");  // Output: /app
await sandbox.exec("export MY_VAR=hello");
await sandbox.exec("echo $MY_VAR");  // Output: hello
```

#### Explicit Sessions for Advanced Use Cases

Create isolated execution contexts within the same sandbox:

```typescript
const sandbox = getSandbox(env.Sandbox, "multi-env");

// Create independent sessions with different environments
const buildSession = await sandbox.createSession({
  name: "build",
  env: { NODE_ENV: "production" },
  cwd: "/build"
});

const testSession = await sandbox.createSession({
  name: "test",
  env: { NODE_ENV: "test" },
  cwd: "/test"
});

// Run commands in parallel with different contexts
await Promise.all([
  buildSession.exec("npm run build"),
  testSession.exec("npm test")
]);
```

#### Security with AI Agents

When using AI coding agents, separate development from execution:

```typescript
// Phase 1: AI agent writes code (with API keys)
const devSession = await sandbox.createSession({
  name: "ai-development",
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
});
await devSession.exec('opencode "build a web server"');

// Phase 2: Run the generated code (without API keys)
const appSession = await sandbox.createSession({
  name: "app-runtime",
  env: { PORT: "3000" }  // Only app-specific vars
});
await appSession.exec("node server.js");
```

> **Best Practice**: Keep AI agent credentials separate from your application runtime to prevent accidental exposure of API keys.

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
- Code interpreter has no internet access (sandbox restriction)
- Some Python/JavaScript packages may not be pre-installed
- Resource limits apply to code execution (CPU, memory)

<h2 id="contributing">🤝 Contributing</h2>

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

```bash
# Clone the repo
git clone https://github.com/cloudflare/sandbox-sdk
cd sandbox-sdk

# Install dependencies
npm install

# Install Bun (if not already installed)
# Visit https://bun.sh for installation instructions
curl -fsSL https://bun.sh/install | bash

# Install container dependencies (required for TypeScript checking)
cd packages/sandbox/container_src && bun install && cd -

# Run tests
npm test

# Build the project
npm run build

# Run type checking and linting
npm run check
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
