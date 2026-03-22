# Minimal Sandbox SDK Example

A minimal Cloudflare Worker that demonstrates the core capabilities of the Sandbox SDK.

## Features

- **Command Execution**: Execute shell commands in isolated containers
- **File Operations**: Read and write files in the sandbox filesystem
- **Lifecycle Events**: Inspect replayable sandbox, session, process, and port transitions
- **Webhook Demo**: Configure a local receiver for lifecycle webhooks
- **Simple API**: Small endpoints demonstrating core sandbox operations and orchestration patterns

## How It Works

This example provides a few small endpoints:

1. **`/run`** - Executes a shell command and returns the output
2. **`/file`** - Creates a file, reads it back, and returns the contents
3. **`/job`** - Starts a background job that emits lifecycle events
4. **`/events`** - Reads the lifecycle event log for replay and auditing
5. **`/webhook/configure`** - Registers a demo webhook receiver in the same Worker
6. **`/webhook/receiver`** - Receives signed lifecycle webhooks and logs them

## API Endpoints

### Execute a Command

```bash
GET http://localhost:8787/run
```

Runs a shell command and returns:

```json
{
  "output": "2 + 2 = 4\n",
  "error": "",
  "exitCode": 0,
  "success": true
}
```

### File Operations

```bash
GET http://localhost:8787/file
```

Creates `/workspace/hello.txt`, reads it back, and returns:

```json
{
  "content": "Hello, Sandbox!"
}
```

### Start an Async Job

```bash
GET http://localhost:8787/job
```

Starts a short-lived background process and returns its identifiers.

### Read Lifecycle Events

```bash
GET http://localhost:8787/events
GET http://localhost:8787/events?afterSeq=2
```

Returns the replayable lifecycle event log, which is useful for:

- async job orchestration
- dashboards
- audit trails
- replay after a restart

### Configure a Demo Webhook Receiver

```bash
GET http://localhost:8787/webhook/configure
```

Registers a local webhook subscription that points back at the same Worker.
This is useful for experimenting with signed lifecycle webhooks locally.

## Setup

1. From the project root, run:

```bash
npm install
npm run build
```

2. Run locally:

```bash
cd examples/minimal # if you're not already here
npm run dev
```

The first run will build the Docker container (2-3 minutes). Subsequent runs are much faster.

## Testing

```bash
# Test command execution
curl http://localhost:8787/run

# Test file operations
curl http://localhost:8787/file

# Start a background job
curl http://localhost:8787/job

# Inspect lifecycle events
curl http://localhost:8787/events

# Configure a demo webhook receiver
curl http://localhost:8787/webhook/configure
```

## Deploy

```bash
npm run deploy
```

After first deployment, wait 2-3 minutes for container provisioning before making requests.

## Next Steps

This minimal example is the starting point for more complex applications. See the [Sandbox SDK documentation](https://developers.cloudflare.com/sandbox/) and the repo's [lifecycle events guide](../../docs/LIFECYCLE_EVENTS.md) for:

- Advanced command execution and streaming
- Background processes and async job runners
- Replayable audit trails and dashboards
- Signed webhook delivery for orchestration
- Preview URLs for exposed services
- Custom Docker images
