# Cloudflare Sandbox SDK

A lean Durable Object base class for Workers that attach a Container Instance.

The SDK streams files through a matching `sandbox-shim` in the container. Native
Container Instance APIs stay visible on `this.ctx.container`: start, snapshot,
restore, labels, inactivity, signals, monitor, and destroy.

## Layout

```text
packages/sandbox/          Worker SDK (`@cloudflare/sandbox`)
crates/sandbox-tools/      Static Linux AMD64 sandbox shim
images/sandbox-tools/      Canonical shim build, checks, and scratch donor image
examples/read-write-files  Streaming reads and writes
examples/snapshot-restore  Native checkpoints and Durable Object resume pointers
examples/instance-lifecycle  Labels, idle timeout, graceful stop, and destroy
```

## Requirements

- Node.js 24.11 or later
- npm 11.16 or later
- Docker, with Linux AMD64 builds enabled

The examples currently deploy with a pinned Wrangler preview that understands
object-valued Container Instance exports.

## Development

```sh
npm install
npm run check
npm test
npm run shim:build
```

`npm test` runs the TypeScript tests and the Docker verification target. That
target formats, lints, and unit-tests the Rust shim, runs the TypeScript/Rust
protocol contract, and checks that the binary is a static Linux AMD64 ELF.

## Using the SDK

Extend `Sandbox` from a container-enabled Durable Object. The container image
must provide `/usr/local/bin/sandbox-shim`.

```ts
import { Sandbox } from "@cloudflare/sandbox";

export class MySandbox extends Sandbox<Env> {
  async read(path: string): Promise<Response> {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Container attachment is unavailable");
    }
    if (!container.running) {
      container.start({
        image: this.env.SANDBOX_IMAGE,
        instance: "lite",
        enableInternet: false,
      });
    }
    return this.files.readFile(path);
  }
}
```

File operations use native Linux semantics. Native container, transport, abort,
and filesystem failures propagate unchanged.

## Images

`images/sandbox-tools` builds a `scratch` donor image that contains only the
shim. Example Dockerfiles copy that binary into their own Alpine runtime:

```dockerfile
ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM alpine:3.23
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
```

Repository scripts tag the donor as `sandbox-tools:local`. A published release
should pin a versioned digest so applications can keep their own base image.

## Examples

Each example is a separate Worker and Dockerfile. Deploy scripts build the local
donor first:

```sh
npm run example:read-write-files:deploy
npm run example:snapshot-restore:deploy
npm run example:instance-lifecycle:deploy
```

See the README in each example directory for the request surface.

## License

Apache License 2.0. See [LICENSE](LICENSE).
