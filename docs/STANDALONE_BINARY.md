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

## Alpine / musl-based Images

For Alpine or other musl-based images, use the `-musl` image variant:

```dockerfile
FROM docker.io/cloudflare/sandbox:latest-musl
```

Or copy the musl binary into your own Alpine image:

```dockerfile
FROM alpine:3.21

# libstdc++ and libgcc are required by the Bun runtime embedded in the binary
# s3fs-fuse and fuse are needed for mountBucket() support
RUN apk add --no-cache bash file git libstdc++ libgcc s3fs-fuse fuse

COPY --from=docker.io/cloudflare/sandbox:latest-musl /container-server/sandbox /sandbox

ENTRYPOINT ["/sandbox"]
```

The glibc binary from the default image will not work on Alpine — always use the `-musl` variant.

### What's included in the musl image

The musl image is a lightweight, functional sandbox. It supports all core SDK methods out of the box:

| Capability                                 | Supported | Notes                                                           |
| ------------------------------------------ | --------- | --------------------------------------------------------------- |
| `exec()`, `startProcess()`                 | ✅        | Shell commands via `bash`                                       |
| `readFile()`, `writeFile()`, `listFiles()` | ✅        | Requires `file` (included)                                      |
| `gitCheckout()`, `listBranches()`          | ✅        | Requires `git` (included)                                       |
| `mountBucket()`, `unmountBucket()`         | ✅        | Requires `s3fs-fuse` and `fuse` (included)                      |
| `exposePort()`                             | ✅        |                                                                 |
| `runCode()` (JavaScript/TypeScript)        | ❌        | Needs `node` or `bun` on PATH — `apk add nodejs`                |
| `runCode()` (Python)                       | ❌        | Needs `python3` on PATH — install from Alpine packages or pyenv |

## How CMD Passthrough Works

The `/sandbox` binary acts as a supervisor:

1. Starts HTTP API server on port 3000
2. Spawns your CMD as a child process
3. Forwards SIGTERM/SIGINT to the child
4. If CMD exits 0, server keeps running; non-zero exits terminate the container

## Required Dependencies

| Dependency           | Required For                                    | Install Command            |
| -------------------- | ----------------------------------------------- | -------------------------- |
| `file`               | `readFile()`, `writeFile()`, any file operation | `apt-get install file`     |
| `git`                | `gitCheckout()`, `listBranches()`               | `apt-get install git`      |
| `bash`               | Everything (core requirement)                   | Usually pre-installed      |
| `libstdc++` `libgcc` | Alpine/musl only: Bun runtime C++ dependencies  | `apk add libstdc++ libgcc` |

Most glibc-based images (node:slim, python:slim, ubuntu) include everything except `file` and `git`. Alpine images also need `bash`, `libstdc++`, and `libgcc`.

## What Works Without Extra Dependencies

- `exec()` - Run shell commands
- `startProcess()` - Background processes
- `exposePort()` - Expose services

## Troubleshooting

**"Failed to detect MIME type"** - Install `file`

**"git: command not found"** - Install `git` (only needed for git operations)

**"Executable not found in $PATH: bash"** - Install `bash` (`apk add bash` on Alpine)

**"Error loading shared library libstdc++.so.6"** - Install `libstdc++` and `libgcc` (`apk add libstdc++ libgcc` on Alpine)

**Commands hang** - Ensure `bash` exists at `/bin/bash`

## Note on Code Interpreter

`runCode()` requires language runtimes installed in the container:

- **JavaScript/TypeScript**: Needs `node` or `bun` on PATH. Add `apk add nodejs` on Alpine or `apt-get install nodejs` on Debian.
- **Python**: Needs `python3` on PATH. Add `apk add python3` on Alpine or `apt-get install python3` on Debian.
