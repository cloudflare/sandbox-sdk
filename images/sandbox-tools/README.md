# Sandbox tools image

This Dockerfile is the canonical build for the static `sandbox-shim` binary. Its
`image` target is a `scratch` donor image rather than a runnable sandbox.

Build the local donor used by this repository's examples:

```sh
npm run shim:build
```

An example copies the shim into its own runtime image:

```dockerfile
ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM alpine:3.23
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
```

The local tag is a development address. A published release should use a versioned,
digest-pinned donor image so applications can retain their own base image without
installing the Rust toolchain.
