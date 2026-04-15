# Cloudflare Sandbox

Secure, isolated code execution containers for [Cloudflare Workers](https://developers.cloudflare.com/workers/). Run untrusted code safely — execute commands, manage files, run background processes, and expose services from your Workers applications.

## Image Variants

All images are published as tags on `cloudflare/sandbox`:

| Tag                  | Base         | Description                                                    |
| -------------------- | ------------ | -------------------------------------------------------------- |
| `<version>`          | Ubuntu 22.04 | Default — Node.js 20, Bun, Git, curl, jq, and common utilities |
| `<version>-python`   | Ubuntu 22.04 | Default + Python 3.11 with matplotlib, numpy, pandas, ipython  |
| `<version>-opencode` | Ubuntu 22.04 | Default + [OpenCode](https://opencode.ai) CLI                  |
| `<version>-musl`     | Alpine 3.21  | Minimal Alpine-based image with Git, curl, and bash            |
| `<version>-desktop`  | Ubuntu 22.04 | Full Linux desktop (XFCE) with Xvfb, VNC, and noVNC            |

## Usage

These images are designed to be used with the [`@cloudflare/sandbox`](https://www.npmjs.com/package/@cloudflare/sandbox) SDK. Reference them in your project's `Dockerfile`:

```dockerfile
FROM cloudflare/sandbox:0.8.11-python
```

Then configure your `wrangler.toml` to use the image:

```toml
[containers]
image = "./Dockerfile"
max_instances = 1
```

See the [Getting Started guide](https://developers.cloudflare.com/sandbox/get-started/) for a complete walkthrough.

## Architecture

Each image runs a lightweight HTTP server (port 3000) that the Sandbox SDK communicates with. The server handles command execution, file operations, process management, and port exposure. Images are built for `linux/amd64`.

## Documentation

- [Full Documentation](https://developers.cloudflare.com/sandbox/)
- [API Reference](https://developers.cloudflare.com/sandbox/api/)
- [Examples](https://github.com/cloudflare/sandbox-sdk/tree/main/examples)
- [GitHub Repository](https://github.com/cloudflare/sandbox-sdk)

## License

[Apache License 2.0](https://github.com/cloudflare/sandbox-sdk/blob/main/LICENSE)
