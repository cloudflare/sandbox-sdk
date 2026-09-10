# Sandbox workspace tools

This Dockerfile builds `sandbox-shim`. The `image` target is a donor, not a sandbox.

Done when `sandbox-tools:local` exists.

```sh
npm run shim:build
```

Copy the binary into your image:

```dockerfile
ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM alpine:3.23
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
```

Pin a versioned donor in production. Keep your own base image.
