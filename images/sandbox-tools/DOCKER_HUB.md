# cloudflare/sandbox

This image ships `sandbox-shim`, the helper that [`@cloudflare/sandbox`](https://www.npmjs.com/package/@cloudflare/sandbox) runs inside a sandbox. It contains only the binary, at `/usr/local/bin/sandbox-shim`, so it does not run on its own.

Copy the binary into your sandbox image. Use the tag that equals your installed `@cloudflare/sandbox` version, so the shim and the package come from the same release:

```dockerfile
FROM node:24-trixie-slim
COPY --from=docker.io/cloudflare/sandbox:<VERSION> /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
```

The binary is static and built for `linux/amd64`, so it runs in any Linux image for that architecture.

For how to build a sandbox image and use the package, refer to the [Sandbox documentation](https://developers.cloudflare.com/sandbox/).

Tags before `1.0.0` are complete sandbox images for `@cloudflare/sandbox` 0.x.
