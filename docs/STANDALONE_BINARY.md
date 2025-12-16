# Standalone Binary Pattern

Add Cloudflare Sandbox capabilities to any Docker image by copying the `/sandbox` binary.

## Basic Usage

```dockerfile
FROM node:20-slim

# Required: install 'file' for SDK file operations
RUN apt-get update && apt-get install -y --no-install-recommends file \
    && rm -rf /var/lib/apt/lists/*

COPY --from=cloudflare/sandbox:latest /container-server/sandbox /sandbox

ENTRYPOINT ["/sandbox"]
CMD ["/your-startup-script.sh"]  # Optional: runs after server starts
```

## How CMD Passthrough Works

The `/sandbox` binary acts as a supervisor:

1. Starts HTTP API server on port 3000
2. Spawns your CMD as a child process
3. Forwards SIGTERM/SIGINT to the child
4. If CMD exits 0, server keeps running; non-zero exits terminate the container

## Required Dependencies

| Dependency | Required For                                    | Install Command        |
| ---------- | ----------------------------------------------- | ---------------------- |
| `file`     | `readFile()`, `writeFile()`, any file operation | `apt-get install file` |
| `git`      | `gitCheckout()`, `listBranches()`               | `apt-get install git`  |
| `bash`     | Everything (core requirement)                   | Usually pre-installed  |

Most base images (node:slim, python:slim, ubuntu) include everything except `file` and `git`.

## What Works Without Extra Dependencies

- `exec()` - Run shell commands
- `startProcess()` - Background processes
- `exposePort()` - Expose services

## Troubleshooting

**"Failed to detect MIME type"** - Install `file`

**"git: command not found"** - Install `git` (only needed for git operations)

**Commands hang** - Ensure `bash` exists at `/bin/bash`

## Note on Code Interpreter

`runCode()` requires Python/Node executors not included in the standalone binary. Use the official sandbox images for code interpreter support.
