# Cloudflare Sandbox

Secure, isolated code execution containers for [Cloudflare Workers](https://developers.cloudflare.com/workers/). Run untrusted code safely — execute commands, manage files, run background processes, and expose services from your Workers applications.

## Image Variants

All images are published as tags on `cloudflare/sandbox`:

| Tag                  | Base         | Description                                                    |
| -------------------- | ------------ | -------------------------------------------------------------- |
| `<version>`          | Ubuntu 22.04 | Default — Node.js 24, Bun, Git, curl, jq, and common utilities |
| `<version>-python`   | Ubuntu 22.04 | Default + Python 3.11 with matplotlib, numpy, pandas, ipython  |
| `<version>-opencode` | Ubuntu 22.04 | Default + [OpenCode](https://opencode.ai) CLI                  |
| `<version>-musl`     | Alpine 3.21  | Minimal Alpine-based image with Git, curl, and bash            |

## Usage

These images are designed to be used with the [`@cloudflare/sandbox`](https://www.npmjs.com/package/@cloudflare/sandbox) SDK. Reference them in your project's `Dockerfile`:

```dockerfile
FROM cloudflare/sandbox:0.12.4-python
```

Then configure your `wrangler.toml` to use the image:

```toml
[containers]
image = "./Dockerfile"
max_instances = 1
```

See the [Getting Started guide](https://developers.cloudflare.com/sandbox/get-started/) for a complete walkthrough.

## Custom Node.js versions

Published sandbox images include Node.js 24 by default. If your workload requires a different Node.js version, build a custom image with the `NODE_VERSION` Docker build argument:

```bash
docker buildx build \
  --build-arg NODE_VERSION=22 \
  --target default \
  -f packages/sandbox/Dockerfile \
  .
```

## Architecture

Each image runs a lightweight HTTP server (port 3000) that the Sandbox SDK communicates with. The server handles command execution, file operations, process management, and port exposure. Images are built for `linux/amd64`.

## Local development behind a TLS-intercepting proxy

If your machine runs Cloudflare WARP / Zero Trust (or any other proxy
that re-signs TLS with a corporate root), the sandbox container must
trust that root or outbound HTTPS calls fail with
`x509: certificate signed by unknown authority`. The Dockerfile accepts
a `wrangler_ca` build secret that gets appended to the image's CA
bundle and registered with `update-ca-certificates`:

```bash
docker build \
  -f packages/sandbox/Dockerfile \
  --target default \
  --secret id=wrangler_ca,src="$NODE_EXTRA_CA_CERTS" \
  -t my-sandbox-image .
```

WARP's installer sets `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and
`REQUESTS_CA_BUNDLE` to a bundle that includes the corporate root, so
passing `$NODE_EXTRA_CA_CERTS` is the easiest way to wire it through.
Local builds done via `npm run docker:rebuild` already pass this
secret — you only need this when invoking `docker build` directly.

When the secret isn't passed (CI, fresh checkout without WARP), the
build is a no-op and the resulting image trusts only the standard
public CAs.

**Known limitation for `sandbox.tunnels`.** Even with the CA bundle
trusted, WARP's Zero Trust egress policy can block outbound traffic
to `api.trycloudflare.com` and the cloudflared edge endpoints
outright. When that happens, `tunnels.create()` hangs waiting for the
edge handshake and eventually times out. The workaround is to run
with WARP disabled or to add an egress exception for those
destinations.

## Documentation

- [Full Documentation](https://developers.cloudflare.com/sandbox/)
- [API Reference](https://developers.cloudflare.com/sandbox/api/)
- [Examples](https://github.com/cloudflare/sandbox-sdk/tree/main/examples)
- [GitHub Repository](https://github.com/cloudflare/sandbox-sdk)

## License

[Apache License 2.0](https://github.com/cloudflare/sandbox-sdk/blob/main/LICENSE)
