# Mount S3-compatible storage

`S3Mounts` attaches one S3 bucket or bucket prefix to a running Container through `s3fs`.
The Worker retains the real S3 credentials and re-signs the requests that cross the Container
boundary.

Use this API for tools that require a filesystem path but can tolerate object-store semantics. Do
not use it to turn S3 into a POSIX filesystem.

## Prepare the image

The image needs FUSE, `s3fs`, and `/usr/local/bin/sandbox-shim`. Build the shim donor first:

```sh
npm run shim:build
```

Copy the shim into your own Linux AMD64 image. For example:

```dockerfile
ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM ubuntu:24.04
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
        ca-certificates fuse3 s3fs \
    && rm -rf /var/lib/apt/lists/*
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
EXPOSE 8080
CMD ["sleep", "infinity"]
```

Local Container preparation requires the image to declare at least one port. `S3Mounts` does not
use that inbound port; the example exposes `8080` only to satisfy the Container image contract.

Use the same Container image locally and in production so that the `s3fs` version and its retry,
timeout, and cache behavior do not drift between environments.

`wrangler dev`, the Cloudflare Vite plugin, and direct Miniflare grant local Containers the
privileges needed by FUSE when Docker runs in a virtual machine, including Docker on macOS and
Windows Subsystem for Linux. Rootless Docker on Linux is supported when `/dev/fuse` is available.
Rootful Docker on Linux does not support local FUSE mounts by default. See
[FUSE support during local development](https://developers.cloudflare.com/containers/guides/local-dev/#fuse-support)
for current requirements and troubleshooting.

Before depending on local development, verify that the exact Wrangler version used by the
application exposes the Durable Object's attached Container through `this.ctx.container`. A
successful image build alone does not prove that the local Container, outbound interceptor, and
FUSE mount are available.

Keep `nodejs_compat` enabled in the Worker, as shown in [Run a Linux task](get-started.md).

## Export the gateway

Re-export `S3Gateway` from the Worker module. This makes a route-scoped loopback service available
through `ctx.exports`:

```ts
import { S3Mounts } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

export { S3Gateway } from "@cloudflare/sandbox";

export class WorkspaceSandbox extends DurableObject<Env> {
  readonly mounts = new S3Mounts(this.requireContainer(), this.ctx.exports.S3Gateway);

  // ...
}
```

`S3Gateway` is infrastructure for `S3Mounts`; do not expose it as an application HTTP route.
Named `WorkerEntrypoint` exports appear in `ctx.exports` automatically; do not add `S3Gateway` to
the Wrangler `exports` object used for Durable Object and Container configuration.

## Mount a bucket prefix

Start the Container before mounting. The package does not start, monitor, restart, or destroy the
caller-owned Container.

```ts
async mountModels(): Promise<void> {
  const container = await this.ensureRunning();
  const mounts = new S3Mounts(container, this.ctx.exports.S3Gateway);

  await mounts.mount({
    mountPath: "/mnt/models",
    source: {
      type: "s3",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      bucket: "model-artifacts",
      credentials: {
        type: "static",
        accessKeyId: this.env.S3_ACCESS_KEY_ID,
        secretAccessKey: this.env.S3_SECRET_ACCESS_KEY,
      },
    },
    keyPrefix: "production/current",
    access: "read-only",
  });
}
```

The endpoint must be an HTTP or HTTPS origin without credentials, a path, query, or fragment. Use
an S3-compatible API endpoint. This release does not accept an R2 binding or translate R2 requests;
an R2 bucket can be used only through its S3-compatible endpoint and S3 credentials.

`keyPrefix` is directory scoped. A non-empty value is normalized with a trailing slash. `access`
is required; use `"read-only"` unless the guest must mutate objects.

`mountPath` must be a normalized, non-root absolute path. It cannot overlap `/proc/self/mountinfo`,
`/run/sandbox/s3-mounts`, or `/usr/local/bin/sandbox-shim` because those paths are part of the
control plane.

Pass additional `s3fs` flags through `s3fsOptions`. Boolean `true` emits a bare option, `false`
omits it, and strings or finite numbers emit `name=value`. The package rejects options that can
replace its route, credentials, access mode, process mode, or filesystem identity. Treat every
extra flag as part of the durable mount configuration and test it against your backend.

`mount()` is convergent:

- An absent mount is created.
- An existing managed mount with the same configuration is adopted and its route is refreshed.
- A stale marker with the same configuration is repaired.
- A different filesystem or configuration returns `S3_MOUNT_CONFLICT` instead of replacing it.

If a failed mount leaves a stale intent and the next request needs a different configuration, call
`unmount()` to revoke the recorded route and clear the stale intent before mounting the new
configuration.

`S3Mounts` does not retry lifecycle operations, route updates, or credential-provider calls. The
Worker gateway also configures its upstream signer not to retry because request bodies can be
non-replayable streams. Apply lifecycle retries at the application layer only after reconciling
the observed state and deciding that the operation is safe to repeat.

`s3fs` separately owns the S3 transactions generated by filesystem operations and may retry them.
Its defaults depend on the `s3fs` version in the Container image; version 1.93 defaults to five
transaction retries, a 300-second connection timeout, a 120-second read/write timeout, a
900-second metadata-cache lifetime, and negative lookup caching. Set options such as `retries`,
`connect_timeout`, `readwrite_timeout`, and `stat_cache_expire` explicitly through `s3fsOptions`
when the application needs a specific policy. These options are part of the durable mount
configuration, so changing them requires a completed unmount before mounting the new
configuration.

## Use renewable credentials

Static credentials remain in the Worker, but they live for as long as the route configuration. For
short-lived credentials, pass a Fetcher such as a Service Binding:

```ts
credentials: {
  type: "provider",
  fetcher: this.env.S3_CREDENTIALS,
}
```

For each authorized upstream request, the gateway sends `GET
https://credentials.sandbox.internal/` with `Accept: application/json` to the Fetcher. Return at
most 16 KiB of JSON. Use the expiration supplied by the credential issuer rather than a fixed
example timestamp:

```ts
return Response.json({
  accessKeyId: temporaryCredentials.accessKeyId,
  secretAccessKey: temporaryCredentials.secretAccessKey,
  sessionToken: temporaryCredentials.sessionToken,
  expiresAt: temporaryCredentials.expiration.getTime(),
});
```

`expiresAt` is an absolute Unix timestamp in milliseconds and must be in the future. The provider
must return credentials with enough remaining lifetime to reach the S3 endpoint; the package does
not impose an arbitrary minimum-lifetime window. The provider is called per request; the package
does not cache credentials and does not retry provider failures. Use a narrowly scoped role that
grants only the configured bucket and prefix.

## Inspect and unmount

`inspect()` reports current attachment, FUSE, gateway, and upstream evidence without repairing
anything:

```ts
const state = await mounts.inspect("/mnt/models");
if (state.attachment.status === "managed") {
  console.log(state.fuse.status, state.gateway.status);
}
```

`inspect()` waits for an in-flight `mount()` or `unmount()` on the same path before capturing the
guest attachment and FUSE evidence under the lifecycle path lock. The local snapshot includes a
`statfs` call to the FUSE filesystem, which can itself block if the filesystem is unresponsive.
After that snapshot completes, the lock is released before probing the gateway: gateway and
upstream evidence can therefore be newer than the attachment snapshot, and the network probe does
not delay a later route revocation.

There is no package-defined inspection deadline. Use an `AbortSignal` when the application needs
one:

```ts
const state = await mounts.inspect("/mnt/models", {
  signal: AbortSignal.timeout(15_000),
});
```

If the signal aborts while inspection is waiting or probing, `inspect()` rejects with the signal's
reason rather than returning a partial snapshot.

Call `unmount()` before destroying or replacing a running Container:

```ts
await mounts.unmount("/mnt/models");
```

Unmounting a managed path first replaces its credentialed route with a deny gateway, then requests
a normal unmount. It never uses force or lazy unmounting. An absent path succeeds without doing
anything.

If normal unmounting returns `S3_MOUNT_BUSY`, the route remains denied and the marker remains for a
safe retry. Stop processes that hold the mount, call `mount()` with the same request to restore the
route if the guest still needs access, then retry `unmount()`. If route denial itself fails, the
filesystem is left mounted and the error is preserved.

After denial, the gateway refuses every new request on that route with HTTP 403 before resolving
credentials and without contacting the S3 origin. A request already in flight when denial is
installed may complete. Denial does not erase file data already cached by the guest, kernel, or
`s3fs`, so a process may still read bytes that were cached earlier. A denied read may instead fail,
succeed with empty or truncated data, or return other stale cached data. Do not depend on a specific
errno or exit status.

Restoring the route with `mount()` does not invalidate stale or negative `s3fs` metadata cached
while the route was denied. Coherent reads resume after the applicable `s3fs` cache expires, after a
completed normal `unmount()` and new `mount()`, or after the Container is replaced. When immediate
coherence matters, stop processes that hold the mount and complete the normal unmount instead of
relying on an in-place route restore.

The platform cannot currently remove an installed outbound route. A completed unmount replaces its
route with a permanent deny handler, and a later fresh mount creates a new route generation. Avoid
using one Container for an unbounded sequence of short-lived mount paths; replace the Container to
discard accumulated denied routes when implementing a high-churn workflow.

Pass an `AbortSignal` as the second argument to `mount()`, `inspect()`, or `unmount()`. Abort reasons,
native Container `exec()` failures, and transport failures are not wrapped.
Cancellation is fail-closed: canceling adoption or unmount after route selection can leave an
otherwise healthy filesystem mounted behind a deny route. Call `mount()` with the same request to
restore access, or call `unmount()` again to finish cleanup.

## Trust boundary

Real access keys and session tokens are held by the Worker gateway. The guest receives fixed dummy
credentials because `s3fs` requires a key pair, but the gateway does not authenticate that
signature. Possession of the private route hostname grants access to the configured mount policy.
The gateway validates the route host, bucket, prefix, access mode, HTTP method, S3 operation shape,
and S3 headers before re-signing a request. Unknown and administrative operation shapes fail
closed. Requests are not forwarded with the guest's authorization header. The route identifier is
discoverable from guest mount state, so every process in the guest shares the mount capability.

This boundary does not make an untrusted guest harmless. A compromised guest can perform every
operation allowed by the mount within its configured prefix. Use read-only mounts where possible,
narrow IAM policy independently of the gateway, and avoid sharing credentials across tenants.

## Filesystem semantics

The mounted path retains S3 and `s3fs` behavior:

- Directories are inferred from object keys and may require marker objects.
- Rename is generally copy-then-delete, not atomic rename.
- File locking, hard links, ownership, permissions, and atomic replacement are not POSIX contracts.
- Caching and consistency depend on `s3fs` and the S3-compatible backend, including the denial and
  restoration behavior described under [Inspect and unmount](#inspect-and-unmount).
- Interrupted writes and multipart uploads can leave remote work to clean up.

The release integration suite exercises these operations against MinIO. S3-compatible services can
differ in path-style addressing, multipart behavior, conditional requests, and error responses;
verify the configured operations against the exact backend used in production. `inspect()` issues
a prefix-scoped bucket-list request, so credentials that can read a known object but cannot list the
configured bucket and prefix will report an upstream access rejection.

Design application state and coordination outside this mount. Use the mount for artifacts, model
inputs, build outputs, and similar object-shaped data.

## Errors

`SandboxS3MountError.is(cause)` recognizes mount errors across local and JSRPC boundaries:

| Code                    | Meaning                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `S3_MOUNT_CONFLICT`     | Another filesystem or configuration owns the path                |
| `S3_MOUNT_BUSY`         | Normal unmounting reported that the mount is in use              |
| `S3_MOUNT_FAILED`       | `s3fs`, FUSE, probing, or another managed mount operation failed |
| `S3_MOUNT_INCOMPATIBLE` | The guest marker uses an unsupported protocol version            |

Malformed shim exchanges throw `SandboxProtocolError`. Input validation throws `TypeError`.
