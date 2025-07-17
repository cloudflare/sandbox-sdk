# Cloudflare Containers Documentation

This comprehensive documentation combines information from the @cloudflare/containers NPM package and official Cloudflare documentation.

## Overview

Cloudflare Containers (Beta) enable you to run containerized applications on Cloudflare's edge network. With Containers, you can:

- Run resource-intensive applications that require CPU cores running in parallel, large amounts of memory or disk space
- Run applications and libraries that require a full filesystem, specific runtime, or Linux-like environment
- Deploy existing applications and tools distributed as container images
- Write code in any programming language, built for any runtime

Container instances are spun up on-demand and controlled by code you write in your Worker. The @cloudflare/containers library provides a way to deploy and manage containers globally, leveraging Cloudflare Workers and Durable Objects for stateful container management.

## Installation

```bash
npm install @cloudflare/containers
```

## Basic Usage

### Define a Container Class

```typescript
import { Container } from '@cloudflare/containers';

export class MyContainer extends Container {
  // Configure default port for the container
  defaultPort = 8080;
  
  // Set how long the container should stay active without requests
  // Supported formats: "10m" (minutes), "30s" (seconds), "1h" (hours), or a number (seconds)
  sleepAfter = "10m";
}
```

### Handle Requests in a Worker

```typescript
import { Container, getRandom } from '@cloudflare/containers';

export class MyContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "1m";
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;

    // Route requests to a specific container instance
    if (pathname.startsWith("/specific/")) {
      let id = env.MY_CONTAINER.idFromName(pathname);
      let stub = env.MY_CONTAINER.get(id);
      return await stub.fetch(request);
    }

    // Load balance across multiple instances
    let container = await getRandom(env.MY_CONTAINER, 5);
    return await container.fetch(request);
  }
};
```

## Container Properties

### Core Properties

- **defaultPort** (number): The default port the container will listen on
- **sleepAfter** (string | number): Duration after which the container will sleep if inactive
- **manualStart** (boolean): If true, container won't start automatically
- **requiredPorts** (number[]): Array of ports that should be checked during startup
- **env** or **envVars** (Record<string, string>): Environment variables to pass to the container
- **entrypoint** (string[]): Custom entrypoint to override container default
- **enableInternet** (boolean): Whether to enable internet access (default: true)

### Example Configuration

```typescript
export class ConfiguredContainer extends Container {
  // Default port for the container
  defaultPort = 9000;

  // Set the timeout for sleeping the container after inactivity
  sleepAfter = "2h";

  // Environment variables to pass to the container
  envVars = {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    APP_PORT: '9000'
  };

  // Custom entrypoint to run in the container
  entrypoint = ['node', 'server.js', '--config', 'production.json'];

  // Enable internet access for the container
  enableInternet = true;
}
```

## Lifecycle Methods

Override these methods to add custom behavior:

```typescript
export class MyContainer extends Container {
  defaultPort = 8080;

  // Called when container starts
  override onStart(): void {
    console.log('Container started!');
  }

  // Called when container shuts down
  override onStop(): void {
    console.log('Container stopped!');
  }

  // Called on errors
  override onError(error: unknown): any {
    console.error('Container error:', error);
    throw error;
  }
}
```

## Container Methods

### fetch(request)
Default handler to forward HTTP requests to the container. Can be overridden.

### containerFetch(request, port?)
Sends an HTTP or WebSocket request to the container.

```typescript
// Forward to default port
const response = await this.containerFetch(request);

// Forward to specific port
const response = await this.containerFetch(request, 9000);

// Using fetch-style syntax
const response = await this.containerFetch('/api/data', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ query: 'example' })
});
```

### start()
Starts the container without waiting for ports to be ready.

### startAndWaitForPorts(ports?, maxTries?)
Starts the container and waits for specified ports to be ready.

```typescript
// Wait for default port
await this.startAndWaitForPorts();

// Wait for specific port
await this.startAndWaitForPorts(3000);

// Wait for multiple ports
await this.startAndWaitForPorts([8080, 9090, 3000]);
```

### stop(reason?)
Stops the container.

### renewActivityTimeout()
Manually renews the container activity timeout to prevent shutdown.

```typescript
async performBackgroundTask(): Promise<void> {
  // Do some work...
  
  // Renew the container's activity timeout
  await this.renewActivityTimeout();
  console.log('Container activity timeout extended');
}
```

## Manual Container Start

For more control over container lifecycle:

```typescript
export class ManualStartContainer extends Container {
  defaultPort = 8080;
  requiredPorts = [8080, 9090, 3000];
  
  // Disable automatic container startup
  manualStart = true;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Start the container if it's not already running
    if (!this.ctx.container.running) {
      if (url.pathname === '/start') {
        // Just start the container
        await this.start();
        return new Response('Container started!');
      }
      else if (url.pathname === '/start-api') {
        // Wait for specific port
        await this.startAndWaitForPorts(3000);
        return new Response('API port is ready!');
      }
      else if (url.pathname === '/start-all') {
        // Wait for all required ports
        await this.startAndWaitForPorts();
        return new Response('All container ports are ready!');
      }
    }

    return await this.containerFetch(request);
  }
}
```

## Load Balancing

Use helper functions to distribute load across multiple container instances:

```typescript
import { Container, getContainer, getRandom } from '@cloudflare/containers';

export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);

    // Load balance across 5 container instances
    if (url.pathname === '/api') {
      const containerInstance = await getRandom(env.MY_CONTAINER, 5);
      return containerInstance.fetch(request);
    }

    // Direct request to a specific container
    if (url.pathname.startsWith('/specific/')) {
      const id = url.pathname.split('/')[2] || 'default';
      const containerInstance = getContainer(env.MY_CONTAINER, id);
      return containerInstance.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  }
};
```

## Environment Variables and Secrets

### Class-level Environment Variables

```typescript
class MyContainer extends Container {
  defaultPort = 5000;
  envVars = {
    MY_SECRET: this.env.MY_SECRET,
    CUSTOM_VAR: "value"
  };
}
```

### Per-Instance Environment Variables

```typescript
export class MyContainer extends Container {
  defaultPort = 8080;
  manualStart = true;
}

export default {
  async fetch(request, env) {
    let idOne = env.MY_CONTAINER.idFromName('instance-1');
    let instanceOne = env.MY_CONTAINER.get(idOne);

    await instanceOne.start({
      envVars: {
        INSTANCE_ID: "1",
        API_KEY: env.SECRET_STORE.API_KEY_ONE,
      }
    });

    return new Response('Container instance launched');
  }
}
```

## Wrangler Configuration

Configure containers in your `wrangler.toml`:

```toml
name = "my-container-worker"

[[containers]]
max_instances = 10
name = "hello-containers"
class_name = "MyContainer"
image = "./Dockerfile"
instance_type = "standard"  # Options: "dev", "basic", "standard"

[[durable_objects.bindings]]
name = "MY_CONTAINER"
class_name = "MyContainer"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["MyContainer"]

# Enable observability for container logs
[observability]
enabled = true
```

Or use the newer `wrangler.jsonc` format:

```jsonc
{
  "name": "my-container-worker",
  "containers": [
    {
      "max_instances": 10,
      "name": "hello-containers",
      "class_name": "MyContainer",
      "image": "./Dockerfile",
      "instance_type": "standard"
    }
  ],
  "durable_objects": {
    "bindings": [
      {
        "name": "MY_CONTAINER",
        "class_name": "MyContainer"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["MyContainer"]
    }
  ],
  "observability": {
    "enabled": true
  }
}
```

Important configuration notes:
- `image` points to a Dockerfile or to a directory containing a Dockerfile
- `class_name` must be a Durable Object class name
- `max_instances` declares the maximum number of simultaneously running container instances
- The Durable Object must use `new_sqlite_classes` not `new_classes`
- `instance_type` specifies the container resources (see Instance Types section)

## Deployment

1. Create a new worker with the containers template:
```bash
npm create cloudflare@latest -- --template=cloudflare/templates/containers-template
```

2. Build and deploy:
```bash
wrangler deploy
```

3. Or build and push container images separately:
```bash
# Build and push in one command
wrangler containers build -p -t <tag> .

# Or push a pre-built image
wrangler containers push <image>:<tag>
```

## Complete Example: Multi-Port Container

```typescript
import { Container } from '@cloudflare/containers';

export class MultiPortContainer extends Container {
  // No defaultPort - we'll handle ports manually
  
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/api')) {
        // API server runs on port 3000
        return await this.containerFetch(request, 3000);
      }
      else if (url.pathname.startsWith('/admin')) {
        // Admin interface runs on port 8080
        return await this.containerFetch(request, 8080);
      }
      else {
        // Public website runs on port 80
        return await this.containerFetch(request, 80);
      }
    } catch (error) {
      return new Response(`Error: ${error instanceof Error ? error.message : String(error)}`, {
        status: 500
      });
    }
  }
}
```

## Integration with Durable Objects

The @cloudflare/containers library leverages Cloudflare Durable Objects for stateful container instances:

- **idFromName(name)**: Generates a unique Durable Object ID from a string name
- **get(id)**: Retrieves a stub for a Durable Object instance

## Key Features

- HTTP request proxying and WebSocket forwarding
- Simple container lifecycle management
- Configurable sleep timeout that renews on requests
- Load balancing utilities
- Environment variable and secrets management
- Multi-port support
- Internet access control
- Observability integration

## Architecture

### How Containers Run

After deploying a Worker that uses a Container, your image is uploaded to Cloudflare's Registry and distributed globally. Cloudflare pre-schedules instances and pre-fetches images across the globe to ensure quick start times when scaling up container instances.

Key architectural points:
- Each container instance runs inside its own VM for strong isolation
- Containers must be built for the `linux/amd64` architecture
- When a container instance starts, it launches in the nearest pre-warmed location
- Subsequent requests to the same instance are routed to its location
- You're only charged for actively running instances, not pre-warmed images

### Request Lifecycle

1. Request enters Cloudflare and is handled by your Worker
2. Worker routes to a Container via its Durable Object
3. Container instance is started in nearest pre-warmed location (if not already running)
4. Request is proxied to the container on the specified port
5. Container's activity timeout is automatically renewed

Note: Currently, Durable Objects may not be co-located with their Container instance. Cloudflare is working on ensuring co-location in the future.

## Platform Details

### Instance Types

Container resources are set through predefined instance types:

| Instance Type | Memory | vCPU | Disk |
| --- | --- | --- | --- |
| dev | 256 MiB | 1/16 | 2 GB |
| basic | 1 GiB | 1/4 | 4 GB |
| standard | 4 GiB | 1/2 | 4 GB |

Specify the instance type in your Wrangler configuration using the `instance_type` property.

### Limits (Beta)

While in open beta, the following limits apply:

| Feature | Workers Paid |
| --- | --- |
| Total GB Memory for concurrent instances | 40 GB |
| Total vCPU for concurrent instances | 20 |
| Total GB Disk for concurrent instances | 100 GB |
| Image size | 2 GB |
| Total image storage per account | 50 GB |

Note: These limits will be raised as the beta progresses.

### Predefined Environment Variables

The container runtime automatically sets:
- `CLOUDFLARE_COUNTRY_A2` - Two-letter country code
- `CLOUDFLARE_DEPLOYMENT_ID` - Container instance ID
- `CLOUDFLARE_LOCATION` - Location name
- `CLOUDFLARE_NODE_ID` - Machine ID
- `CLOUDFLARE_REGION` - Region name
- `CLOUDFLARE_PLACEMENT_ID` - Placement ID

## Image Management

### Building and Pushing Images

When running `wrangler deploy`, if your `image` attribute points to a path, Wrangler will:
1. Build your container image locally using Docker
2. Push it to Cloudflare's integrated registry (backed by R2)
3. Handle all authentication automatically

Images must use `registry.cloudflare.com` as the registry.

### Managing Images

```bash
# Build and push in one command
wrangler containers build -p -t <tag> .

# Push a pre-built image
wrangler containers push <image>:<tag>

# Delete images to free up space
wrangler containers delete <image>:<tag>
```

### Using External Images

To use an existing image from another registry:
```bash
docker pull <public-image>
docker tag <public-image> registry.cloudflare.com/<namespace>/<image>:<tag>
wrangler containers push registry.cloudflare.com/<namespace>/<image>:<tag>
```

## Dashboard and Monitoring

Access the [Containers Dashboard](https://dash.cloudflare.com/?to=/:account/workers/containers) to view:
- Container status and health
- Metrics
- Logs (when observability is enabled)
- Links to associated Workers and Durable Objects

Navigate to the dashboard by clicking "Containers" under "Workers & Pages" in your Cloudflare dashboard sidebar.

## Direct Durable Object API

While we recommend using the `Container` class, you can also access lower-level container controls via the Durable Object API:

```typescript
export class MyDurableObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Boot the container when starting the DO
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.container.start({
        env: {
          FOO: "bar",
        },
        enableInternet: false,
        entrypoint: ["node", "server.js"],
      });
    });
  }
}
```

Methods available on `this.ctx.container`:
- `running` - Returns true if container is currently running
- `start(options)` - Boots the container
- `destroy()` - Stops the container

## Beta Information and Roadmap

Containers are currently in beta. Here's what to expect:

### Current Limitations

1. **No autoscaling/load balancing** - Use `getRandom` helper for basic load distribution
2. **Log noise** - Container class uses Durable Object alarms causing extra logs
3. **No Durable Object co-location** - DOs and containers may run in different locations
4. **Non-atomic updates** - Worker code updates immediately while container code rolls out gradually
5. **Limited container placement control** - Containers may start in suboptimal locations

### Upcoming Features

- **Increased limits** - Higher instance sizes and more concurrent instances
- **Native autoscaling** - Utilization-based autoscaling and latency-aware load balancing
- **Reduced log noise** - Automatic filtering of internal logs
- **Dashboard improvements** - Container rollout status and Worker-to-Container links
- **DO co-location** - Durable Objects will run in same location as their container
- **Better placement** - Optimized container placement for lower latency
- **Atomic updates** - Worker and container code will update together
- **Public image support** - Direct configuration of public images in wrangler.jsonc

### Feedback Wanted

The Cloudflare team is actively seeking feedback on:
- Required instance sizes and use cases
- Autoscaling and load balancing needs
- Dashboard features
- API improvements

Share feedback through the [Cloudflare Discord](https://discord.cloudflare.com) or [feedback form](https://forms.gle/AGSq54VvUje6kmKu8).

## Notes

- Containers automatically renew their activity timeout when receiving requests
- WebSocket connections are automatically detected and handled
- Container logs appear in the Cloudflare Dashboard when observability is enabled
- Containers are subject to standard Worker log limits and retention policies
- Ensure Worker code is backwards compatible during deployments due to rolling updates
- Currently no direct TCP/UDP access from end-users (Worker proxy required)

---

# Cloudflare Sandbox SDK Documentation

## Overview

The @cloudflare/sandbox SDK is an experimental library that provides a higher-level abstraction on top of Cloudflare Containers. It simplifies the process of running sandboxed code execution environments with built-in features like file operations, git integration, and session management.

The SDK is designed for use cases where you need to:
- Execute arbitrary code in a secure, isolated environment
- Provide development environments or coding sandboxes
- Run untrusted user code safely
- Build AI coding assistants or code execution platforms

## Installation

```bash
npm install @cloudflare/sandbox
```

## Architecture

The Sandbox SDK builds on top of @cloudflare/containers with these key components:

1. **Sandbox Class**: Extends the Container class with additional methods for code execution
2. **Command Server**: Bun-based HTTP server running inside the container that handles execution requests
3. **Session Management**: Built-in tracking of work sessions and command history
4. **File Operations**: Convenient methods for file manipulation without exec
5. **Git Integration**: Built-in support for cloning repositories

## Basic Setup

### 1. Create or Update Your Dockerfile

```dockerfile
# For amd64 architecture:
FROM docker.io/ghostwriternr/cloudflare-sandbox:0.0.5

# For arm64 architecture:
# FROM docker.io/ghostwriternr/cloudflare-sandbox-arm:0.0.5

EXPOSE 3000

# The command server starts automatically
CMD ["bun", "index.ts"]
```

### 2. Configure wrangler.json

```jsonc
{
  "name": "my-sandbox-worker",
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile",
      "max_instances": 10,
      "instance_type": "standard"
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

### 3. Export the Sandbox Class

In your worker's main file:

```typescript
export { Sandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env) {
    // Your worker logic here
  }
};
```

## Using the Sandbox

### Getting a Sandbox Instance

```typescript
import { getSandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env) {
    // Get or create a sandbox instance
    const sandbox = getSandbox(env.Sandbox, "my-sandbox-id");
    
    // Use the sandbox...
    const result = await sandbox.exec("echo", ["Hello, World!"]);
    return new Response(result.stdout);
  }
};
```

## Available Methods

### exec(command, args, options?)

Execute a command in the sandbox.

```typescript
// Simple command execution
const result = await sandbox.exec("ls", ["-la"]);
console.log(result.stdout);
console.log(result.stderr);
console.log(result.exitCode);

// With streaming output
const streamResult = await sandbox.exec("npm", ["install"], { 
  stream: true 
});
// Returns a Response object with streaming output
```

**Parameters:**
- `command`: The command to execute
- `args`: Array of command arguments
- `options`: Optional object with:
  - `stream`: Boolean to enable streaming output (returns Response instead of result object)

### gitCheckout(repoUrl, options?)

Clone a git repository into the sandbox.

```typescript
// Clone a repository
await sandbox.gitCheckout("https://github.com/user/repo.git");

// Clone a specific branch
await sandbox.gitCheckout("https://github.com/user/repo.git", {
  branch: "develop"
});

// Clone to a specific directory
await sandbox.gitCheckout("https://github.com/user/repo.git", {
  targetDir: "/workspace/my-project"
});

// With streaming output
const response = await sandbox.gitCheckout("https://github.com/user/repo.git", {
  stream: true
});
```

**Parameters:**
- `repoUrl`: The git repository URL
- `options`: Optional object with:
  - `branch`: Specific branch to checkout
  - `targetDir`: Directory to clone into
  - `stream`: Enable streaming output

### File Operations

#### writeFile(path, content, options?)

Write content to a file in the sandbox.

```typescript
// Write text file
await sandbox.writeFile("/app/config.json", JSON.stringify({ port: 3000 }));

// With specific encoding
await sandbox.writeFile("/app/script.sh", "#!/bin/bash\necho Hello", {
  encoding: "utf-8"
});
```

#### readFile(path, options?)

Read content from a file in the sandbox.

```typescript
// Read a file
const content = await sandbox.readFile("/app/config.json");
console.log(content);

// With specific encoding
const script = await sandbox.readFile("/app/script.sh", {
  encoding: "utf-8"
});
```

#### mkdir(path, options?)

Create a directory in the sandbox.

```typescript
// Create a single directory
await sandbox.mkdir("/app/data");

// Create nested directories
await sandbox.mkdir("/app/data/cache/images", {
  recursive: true
});
```

#### deleteFile(path, options?)

Delete a file from the sandbox.

```typescript
await sandbox.deleteFile("/app/temp.txt");

// With streaming response
const response = await sandbox.deleteFile("/app/temp.txt", {
  stream: true
});
```

#### renameFile(oldPath, newPath, options?)

Rename a file in the sandbox.

```typescript
await sandbox.renameFile("/app/old-name.txt", "/app/new-name.txt");
```

#### moveFile(sourcePath, destinationPath, options?)

Move a file from one location to another.

```typescript
await sandbox.moveFile("/tmp/upload.zip", "/app/data/upload.zip");
```

### ping()

Check if the sandbox is responsive.

```typescript
const isAlive = await sandbox.ping();
console.log(`Sandbox is ${isAlive ? 'responsive' : 'not responding'}`);
```

## Advanced Usage

### Session Management

The Sandbox SDK includes built-in session management capabilities that track command history and working state:

```typescript
// The sandbox maintains session state between commands
const sandbox = getSandbox(env.Sandbox, "user-123-session");

// Commands are executed in the same session context
await sandbox.exec("cd", ["/workspace"]);
await sandbox.exec("npm", ["init", "-y"]);
await sandbox.exec("npm", ["install", "express"]);
```

### Custom Docker Images

You can build custom images on top of the Sandbox SDK base image:

```dockerfile
FROM docker.io/ghostwriternr/cloudflare-sandbox:0.0.5

# Install additional tools
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    golang \
    rust

# Install global npm packages
RUN npm install -g typescript @angular/cli vue-cli

EXPOSE 3000

CMD ["bun", "index.ts"]
```

### Integration with VibeKit

For VibeKit integration, the Sandbox SDK can be used as a provider:

```typescript
import { Sandbox, getSandbox } from '@cloudflare/sandbox';

export class CloudflareSandboxProvider implements SandboxProvider {
  async create(config, envs, agentType) {
    const env = (globalThis as any).env;
    const sandboxId = `vibekit-${agentType}-${Date.now()}`;
    const sandbox = getSandbox(env.Sandbox, sandboxId);
    
    return new CloudflareSandboxInstance(sandbox, sandboxId);
  }
}

export class CloudflareSandboxInstance implements SandboxInstance {
  constructor(private sandbox: Sandbox, public sandboxId: string) {}
  
  get commands(): SandboxCommands {
    return {
      run: async (command, options) => {
        // Split command into command and args
        const [cmd, ...args] = command.split(' ');
        
        const result = await this.sandbox.exec(cmd, args, {
          stream: options?.onStdout || options?.onStderr
        });
        
        return {
          exitCode: result.exitCode || 0,
          stdout: result.stdout || '',
          stderr: result.stderr || ''
        };
      }
    };
  }
}
```

## Streaming Responses

Many SDK methods support streaming responses when `stream: true` is passed:

```typescript
// Streaming command output
const response = await sandbox.exec("npm", ["install"], { stream: true });

// The response is a standard Response object with streaming body
const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const chunk = decoder.decode(value);
  console.log('Output:', chunk);
}
```

## Error Handling

```typescript
try {
  const result = await sandbox.exec("false", []);
  // Command that exits with non-zero code
  console.log("Exit code:", result.exitCode); // Will be non-zero
} catch (error) {
  console.error("Execution failed:", error);
}

// File operations
try {
  const content = await sandbox.readFile("/non-existent-file.txt");
} catch (error) {
  console.error("File not found:", error);
}
```

## Best Practices

1. **Sandbox Lifecycle**: Sandboxes are managed by Durable Objects and will automatically sleep after inactivity
2. **Session Isolation**: Use unique sandbox IDs for different users or sessions
3. **Resource Limits**: Be aware of container resource limits (CPU, memory, disk)
4. **Security**: Never execute untrusted commands directly; always validate and sanitize input
5. **Streaming**: Use streaming for long-running commands to provide real-time feedback

## Differences from Direct Container Usage

| Feature | @cloudflare/containers | @cloudflare/sandbox |
|---------|----------------------|-------------------|
| Setup Complexity | More manual setup | Simplified setup |
| Command Execution | Via containerFetch | Built-in exec() method |
| File Operations | Manual implementation | Built-in methods |
| Git Support | Manual implementation | Built-in gitCheckout |
| Session Management | Manual implementation | Built-in support |
| Base Image | Any Linux image | Specific sandbox image |

## Current Limitations

- **Experimental**: The SDK is in active development and APIs may change
- **Image Requirement**: Must use the provided base images or build on top of them
- **No Direct Port Access**: Use exec to run servers, but port forwarding requires container-level configuration
- **Limited to Bun Runtime**: The command server uses Bun (though executed commands can use any runtime)

## Future Roadmap

The Sandbox SDK is actively being developed with planned features including:
- Native support for multiple programming languages
- Enhanced session management and persistence
- Built-in code editor integration
- Improved debugging capabilities
- Direct integration with AI models for code generation

For the latest updates and to provide feedback, visit the [Cloudflare Sandbox GitHub repository](https://github.com/cloudflare/sandbox) or join the discussion in the [Cloudflare Discord](https://discord.cloudflare.com).