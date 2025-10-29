# Minimal Sandbox SDK Example

A minimal Cloudflare Worker that demonstrates the core capabilities of the Sandbox SDK.

## Features

- **Command Execution**: Execute Python code in isolated containers
- **File Operations**: Read and write files in the sandbox filesystem
- **Simple API**: Two endpoints demonstrating basic sandbox operations

## How It Works

This example provides two simple endpoints:

1. **`/run`** - Executes Python code and returns the output
2. **`/file`** - Creates a file, reads it back, and returns the contents

## API Endpoints

### Execute Python Code

```bash
GET http://localhost:8787/run
```

Runs `python -c "print(2 + 2)"` and returns:

```json
{
  "output": "4\n",
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
```

## Deploy

```bash
npm run deploy
```

After first deployment, wait 2-3 minutes for container provisioning before making requests.

## Next Steps

This minimal example is the starting point for more complex applications. See the [Sandbox SDK documentation](https://developers.cloudflare.com/sandbox/) for:

- Advanced command execution and streaming
- Background processes
- Preview URLs for exposed services
- Custom Docker images
