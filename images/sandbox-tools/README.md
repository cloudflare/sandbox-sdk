# Sandbox tools image

This Dockerfile builds `sandbox-shim` into a donor image. The image contains only the binary, at `/usr/local/bin/sandbox-shim`. It is not a sandbox image: application images copy the binary out of it.

Build it locally as `sandbox-tools:local`. Deploying an example from this repository with `npm run example -- deploy <NAME>` builds this image first, and copies the shim from it:

```sh
npm run shim:build
```

Done when `docker image inspect sandbox-tools:local` succeeds.

Releases publish this image as `cloudflare/sandbox`, tagged with the `@cloudflare/sandbox` package version, so that an application's shim matches its package. Each example's `Dockerfile` copies from the published image of the version its `package.json` pins. `DOCKER_HUB.md` is the image's description on Docker Hub. See [Releasing](../../docs/releasing.md).

The `verify` target runs the Rust checks, the contract test, and the binary checks. See [Testing](../../docs/testing.md#shim-checks).
