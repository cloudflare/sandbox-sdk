# Architecture

This page explains how the repository is put together and why. It is for people who change the package, the shim, or the examples. To use the package, read the [Sandbox documentation](https://developers.cloudflare.com/sandbox/).

## A sandbox is a Durable Object and its container

An application defines a Durable Object class with a container. Each sandbox name maps to one Durable Object, and that Durable Object starts, stops, and snapshots its container through `this.ctx.container`. The platform already provides commands (`exec()`), ports (`getTcpPort()`), outbound interception, snapshots, and inactivity timeouts.

`@cloudflare/sandbox` adds two things that the platform does not provide:

- `Files`, structured file operations with Linux errors.
- `S3Mounts` and `S3Gateway`, S3 buckets mounted as directories, with credentials that stay in the Worker.

Everything else is application code. The package does not start, stop, wake, or destroy containers, and it has no `Sandbox` base class for applications to extend.

## The three layers

| Layer    | Path                   | Runs in                                       | Owns                                                                          |
| -------- | ---------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| Package  | `packages/sandbox`     | The Worker, usually inside the Durable Object | The public API, protocol decoding, cancellation, and error translation        |
| Shim     | `crates/sandbox-tools` | The container                                 | The Linux operation itself, and the facts about its outcome                   |
| Examples | `examples/`            | Deployed Workers                              | Application policy: routing, authentication, lifecycle, timeouts, and retries |

The shim is one static binary, `sandbox-shim`, built for `linux/amd64`. It is static so that it runs in any image, whether the image uses glibc, musl, or no libc at all. `images/sandbox-tools` builds it into a donor image, and application images copy it to `/usr/local/bin/sandbox-shim`.

## Why `Files` needs a shim

The platform has no filesystem API for an attached container. `node:fs` in a Worker reads the Worker's own filesystem, not the container's. `exec()` can run `cat` or `stat`, but a command's exit code and stderr text do not carry a reliable errno, and nothing tells the caller that a file opened before it starts sending bytes.

So each `Files` call runs one short-lived `sandbox-shim` process with `exec()`. The process performs one complete Linux operation and reports the result over the protocol described in [Shim protocol](shim-protocol.md). There is no daemon to keep running, restart, or upgrade, and nothing survives between calls.

The shim uses the path it receives as it is. It does not normalize paths, follow or reject symlinks as a policy, check file types first, retry, or lock. Linux decides, and the caller sees what Linux did, including partial effects when an operation fails midway.

The Worker side does only what the shim cannot:

- Checks that the path is a non-empty string without NUL, and that a relative path comes with an absolute `cwd`, which it joins onto the path.
- Moves bytes with Web Streams, so reads and writes apply backpressure end to end.
- Maps the caller's `AbortSignal` to the `exec()` signal, which kills the process.
- Decodes frames, and turns a numeric errno into a `SandboxFileError` with a symbolic `code`.

## Errors

There are three kinds of failure, and each keeps its identity:

- A Linux failure in the container becomes `SandboxFileError`. The shim sends the numeric errno. The package maps it to a name once, using `node:os` `constants.errno`, which is why `Files` needs the `nodejs_compat` flag. Numeric errno is not part of the public API.
- A malformed or unexpected exchange with the shim becomes `SandboxProtocolError`. Examples are the wrong magic bytes, an unsupported protocol version, truncated frames, or a nonzero exit after a success frame.
- Everything else passes through unchanged: `exec()` failures, transport failures, a failing source stream in `writeFile()`, and the abort reason when a signal fires.

The error values are plain `Error` objects with their fields as own properties. The package exports recognizers (`SandboxFileError.is()`, `SandboxProtocolError.is()`, `SandboxS3MountError.is()`) instead of classes, because an error that crosses Durable Object RPC loses its prototype and `instanceof` stops working. The recognizers check the name and the own properties, which survive RPC.

## What stays out of the package

The package leaves these to applications on purpose:

- Container lifecycle: `start()`, `destroy()`, inactivity timeouts, and snapshots. Applications call `this.ctx.container` directly.
- Timeouts and retries. An operation that was canceled or dropped may already have changed the filesystem, so only the application can decide whether repeating it is safe.
- Routing, authentication, and sandbox naming.
- Process supervision, retained logs, and reconnectable terminals. These need a process identity that survives the request that started the process, which the platform does not provide yet. The examples show what applications can build without it.

## Adding to the public API

A new export has to pass two tests:

- The deletion test: without it, every application would have to rebuild substantial, reusable machinery. A thin wrapper over a platform API fails this test.
- The publication test: its contract can be frozen without freezing application policy.

`S3Mounts` passes both. It hides FUSE setup, per-mount outbound routes, request signing, operation-level authorization, and recovery of mounts that outlive a Durable Object instance.

Several candidates failed and became examples or platform requests instead:

- Port readiness. The platform's `getTcpPort()` is the right place for it, and a helper would depend on error message text.
- Outbound credentials. `interceptOutboundHttp()` is already the seam, and each application's credential policy is different.
- HTTP forwarding. `getTcpPort(port).fetch()` already streams bodies, carries WebSockets, and propagates cancellation.
- Live terminals. `exec()` with `pty` already provides the terminal. Reconnecting and flow control are application choices.

The public surface is `packages/sandbox/src/index.ts`. `packages/sandbox/tests/public-api.test.ts` lists the runtime exports and checks several exported types, and `packed-api.test.ts` checks the runtime exports of the built package. Update them in the same change as the surface.

## Examples

Examples are deployable Workers, each built around one job, such as running a coding agent or previewing a web app. They are where lifecycle, naming, authentication, and timeout policy live. For how to write one, see [Examples](examples.md).
