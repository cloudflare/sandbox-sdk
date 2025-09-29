# Local Development

This guide walks you through setting up and developing with the Cloudflare Sandbox SDK locally using `wrangler dev`.

## Prerequisites

- Node.js 18+ installed
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed and authenticated
- Docker installed (for local container development)

## Initial Setup

### 1. Install the SDK

```bash
npm install @cloudflare/sandbox
```

### 2. Create a Dockerfile

> **Note**: This is a temporary requirement that will be removed in future releases.

Create a `Dockerfile` in your project root:

```dockerfile
FROM docker.io/cloudflare/sandbox:0.3.0

# Expose the ports you want to use for local development
EXPOSE 3000
EXPOSE 8080
EXPOSE 3001
```

**Important for Local Development**: The `EXPOSE` instruction is **only required for local development** with `wrangler dev`. In production, all container ports are automatically accessible.

### 3. Configure wrangler.json

Create or update your `wrangler.json`:

```json
{
  "name": "my-sandbox-worker",
  "main": "src/index.ts",
  "compatibility_date": "2024-01-01",
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

### 4. Create Your Worker

Create `src/index.ts`:

```typescript
import { getSandbox, proxyToSandbox } from "@cloudflare/sandbox";

// Export the Sandbox class for Durable Objects
export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

export default {
  async fetch(request: Request, env: Env) {
    // Handle sandbox preview URLs
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/") {
      return new Response("Sandbox Worker is running!");
    }

    // Execute command endpoint
    if (url.pathname === "/exec" && request.method === "POST") {
      const { command, sandboxId = "default" } = await request.json();
      const sandbox = getSandbox(env.Sandbox, sandboxId);
      
      const result = await sandbox.exec(command);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
```

## Development Workflow

### Starting Local Development

```bash
# Start the development server
wrangler dev
```

This will:
1. Build your Worker code
2. Start the local container runtime
3. Expose your Worker at `http://localhost:8787` (or another port)

### Testing Basic Functionality

Once running, test your setup:

```bash
# Health check
curl http://localhost:8787/

# Execute a command
curl -X POST http://localhost:8787/exec \
  -H "Content-Type: application/json" \
  -d '{"command": "echo \"Hello from local sandbox!\""}'
```

### Working with Preview URLs

When you expose ports in your sandbox, they become available via local preview URLs:

```typescript
// In your Worker
const sandbox = getSandbox(env.Sandbox, "web-app");

// Start a web server
await sandbox.writeFile("/workspace/server.js", `
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.json({ message: 'Hello from sandbox!', timestamp: new Date() });
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
`);

await sandbox.exec("cd /workspace && npm init -y && npm install express");
const server = await sandbox.startProcess("node /workspace/server.js");

// Expose the port
const preview = await sandbox.exposePort(3000, { 
  hostname: "localhost:8787"  // Your local wrangler dev URL
});

console.log(`App available at: ${preview.url}`);
// Example: http://3000-web-app.localhost:8787
```

## Development Patterns

### Environment-Specific Configuration

```typescript
interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ENVIRONMENT?: string;
  DEBUG?: string;
}

export default {
  async fetch(request: Request, env: Env) {
    const isLocal = env.ENVIRONMENT === "development" || !env.ENVIRONMENT;
    const debug = env.DEBUG === "true";

    if (debug) {
      console.log(`Request: ${request.method} ${request.url}`);
    }

    const sandbox = getSandbox(env.Sandbox, "dev-sandbox");

    // Set environment variables for the sandbox
    await sandbox.setEnvVars({
      NODE_ENV: isLocal ? "development" : "production",
      DEBUG: debug.toString(),
      LOCAL_DEV: isLocal.toString()
    });

    // ... rest of your logic
  }
};
```

### Hot Reloading Development

Create a development script that automatically rebuilds your sandbox content:

```typescript
// Development helper endpoint
if (url.pathname === "/dev/reload" && request.method === "POST") {
  const { code, language = "javascript" } = await request.json();
  const sandbox = getSandbox(env.Sandbox, "dev-reload");

  // Write and execute code dynamically
  const filename = language === "python" ? "main.py" : "main.js";
  await sandbox.writeFile(`/workspace/${filename}`, code);

  const command = language === "python" 
    ? `python3 /workspace/${filename}`
    : `node /workspace/${filename}`;

  const result = await sandbox.exec(command);
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" }
  });
}
```

### Multi-Service Development

Develop multiple services within one sandbox:

```typescript
async function setupDevelopmentServices(sandbox: ISandbox) {
  // API service
  await sandbox.writeFile("/workspace/api.js", `
    const express = require('express');
    const app = express();
    
    app.use(express.json());
    
    app.get('/api/health', (req, res) => {
      res.json({ status: 'ok', service: 'api' });
    });
    
    app.post('/api/data', (req, res) => {
      res.json({ received: req.body, timestamp: Date.now() });
    });
    
    app.listen(3001, () => console.log('API service on 3001'));
  `);

  // Frontend service
  await sandbox.writeFile("/workspace/frontend.js", `
    const express = require('express');
    const app = express();
    
    app.use(express.static('public'));
    
    app.get('/', (req, res) => {
      res.send(\`
        <!DOCTYPE html>
        <html>
        <head><title>Dev Frontend</title></head>
        <body>
          <h1>Development Frontend</h1>
          <button onclick="fetch('/api/health').then(r=>r.json()).then(console.log)">
            Test API
          </button>
        </body>
        </html>
      \`);
    });
    
    app.listen(3000, () => console.log('Frontend service on 3000'));
  `);

  // Install dependencies
  await sandbox.exec("cd /workspace && npm init -y && npm install express");

  // Start services
  const api = await sandbox.startProcess("node api.js", { 
    processId: "api-service",
    cwd: "/workspace"
  });
  
  const frontend = await sandbox.startProcess("node frontend.js", { 
    processId: "frontend-service",
    cwd: "/workspace"
  });

  return { api, frontend };
}
```

## Debugging and Troubleshooting

### Common Issues

#### 1. Port Connection Refused

```
connect(): Connection refused: container port not found
```

**Solution**: Add the port to your `Dockerfile`:

```dockerfile
FROM docker.io/cloudflare/sandbox:0.3.0

# Add the missing port
EXPOSE 3000
```

#### 2. Container Not Starting

Check your wrangler configuration:

```bash
# Validate wrangler.json
wrangler dev --dry-run

# Check container logs
wrangler tail
```

#### 3. Command Timeouts

Commands timing out after 30 seconds:

```typescript
// Increase timeout for long-running commands
const result = await sandbox.exec("npm install", {
  timeout: 120000  // 2 minutes
});
```

### Debug Logging

Enable debug logging in development:

```typescript
const sandbox = getSandbox(env.Sandbox, "debug-sandbox");

// Enable verbose logging for the client
sandbox.client.onCommandStart = (cmd, args) => 
  console.log(`[DEBUG] Starting: ${cmd} ${args?.join(" ") || ""}`);

sandbox.client.onOutput = (stream, data) => 
  console.log(`[DEBUG] [${stream}] ${data}`);

sandbox.client.onCommandComplete = (success, code) => 
  console.log(`[DEBUG] Completed: success=${success}, code=${code}`);
```

### Performance Monitoring

Monitor sandbox performance during development:

```typescript
async function monitoredExec(sandbox: ISandbox, command: string) {
  const start = Date.now();
  console.log(`[PERF] Starting: ${command}`);
  
  try {
    const result = await sandbox.exec(command, {
      onOutput: (stream, data) => {
        console.log(`[PERF] [${stream}] ${data.substring(0, 100)}...`);
      }
    });
    
    const duration = Date.now() - start;
    console.log(`[PERF] Completed in ${duration}ms: ${command}`);
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    console.log(`[PERF] Failed after ${duration}ms: ${command}`);
    throw error;
  }
}
```

## Testing Strategies

### Unit Testing Your Worker

```typescript
// test/sandbox.test.ts
import { getSandbox } from "@cloudflare/sandbox";

// Mock environment for testing
const mockEnv = {
  Sandbox: {
    // Mock Durable Object namespace
    get: (id: string) => ({
      // Mock sandbox methods
      exec: jest.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: "test output",
        stderr: "",
        command: "test",
        duration: 100,
        timestamp: new Date().toISOString()
      })
    })
  }
};

describe("Sandbox Worker", () => {
  test("executes basic commands", async () => {
    const sandbox = getSandbox(mockEnv.Sandbox, "test");
    const result = await sandbox.exec("echo 'test'");
    
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("test output");
  });
});
```

### Integration Testing

Create integration tests that run against a real local sandbox:

```typescript
// test/integration.test.ts
describe("Sandbox Integration", () => {
  let sandbox: ISandbox;

  beforeEach(async () => {
    // Assuming you have a test environment setup
    sandbox = getSandbox(testEnv.Sandbox, `test-${Date.now()}`);
  });

  test("installs and runs Node.js app", async () => {
    await sandbox.writeFile("/workspace/package.json", JSON.stringify({
      name: "test-app",
      scripts: { start: "node index.js" }
    }));

    await sandbox.writeFile("/workspace/index.js", 
      "console.log('Integration test successful')"
    );

    const result = await sandbox.exec("cd /workspace && npm start");
    expect(result.stdout).toContain("Integration test successful");
  });
});
```

## Best Practices

### 1. Resource Management

```typescript
// Always clean up resources
try {
  const result = await sandbox.exec(command);
  return result;
} finally {
  // Clean up any background processes
  await sandbox.killAllProcesses();
}
```

### 2. Error Handling

```typescript
async function robustSandboxOperation(sandbox: ISandbox) {
  try {
    return await sandbox.exec("complex-operation");
  } catch (error) {
    if (error.message.includes("timeout")) {
      console.log("Operation timed out, retrying with higher timeout");
      return await sandbox.exec("complex-operation", { timeout: 60000 });
    }
    throw error;
  }
}
```

### 3. Environment Consistency

```typescript
// Ensure consistent environment across local and production
const commonEnvVars = {
  NODE_ENV: process.env.NODE_ENV || "development",
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  FEATURE_FLAGS: process.env.FEATURE_FLAGS || "{}"
};

await sandbox.setEnvVars(commonEnvVars);
```

This guide provides everything you need to develop locally with the Cloudflare Sandbox SDK, from initial setup through debugging and testing strategies.