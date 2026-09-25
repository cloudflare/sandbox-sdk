# S3 mounts design

This page explains how `S3Mounts` and `S3Gateway` work and why. For how to use them, see [Mount an R2 bucket](https://developers.cloudflare.com/sandbox/files/mount-an-r2-bucket/) and the [S3Mounts reference](https://developers.cloudflare.com/sandbox/reference/s3-mounts/). For the wire format between the package and the shim, see [Shim protocol](shim-protocol.md#s3-mount).

The TypeScript side is `packages/sandbox/src/s3-mounts/`. The Rust side is `crates/sandbox-tools/src/s3_mount/`.

## Credentials stay in the Worker

`s3fs` in the container needs an S3 endpoint and a key pair. Giving it real credentials would let any process in the container read them. Instead:

1. The shim starts `s3fs` with a placeholder key pair and the endpoint `http://s3-<ROUTE_ID>.sandbox.internal`.
2. The Durable Object registers that hostname with `interceptOutboundHttp()`, pointing at `S3Gateway` with the mount's settings in its props.
3. `S3Gateway` checks each request against the mount, drops the placeholder signature, signs the request again with the real credentials, and forwards it to the real endpoint.

Credentials are either static values in the props, or a `Fetcher` that returns JSON with `accessKeyId`, `secretAccessKey`, an optional `sessionToken`, and `expiresAt` in milliseconds. The gateway calls the `Fetcher` on every request and does not cache the result, so a provider that is slow or rate-limited should cache on its side. Signing uses `aws4fetch` with retries turned off, because retrying is the application's decision.

The container is one trust domain. Any process in it can use a mount's route, and the route ID is visible in `/proc/self/mountinfo` and on the `s3fs` command line. The gateway limits what the route can do, not who in the container uses it.

## The gateway allows known operations only

`packages/sandbox/src/s3-mounts/gateway-policy.ts` accepts a request only when it matches one of the request shapes that `s3fs` sends. It checks the following before any credential is resolved:

- The `Host` header is the mount's route hostname, and the path addresses the mount's bucket.
- The method and query parameters match an allowed operation exactly. The allowed operations are: bucket `HEAD`, `GET ?location`, list objects version 1 and 2 with their known parameters, object `GET`, `HEAD`, `PUT`, and `DELETE`, and the multipart upload calls. A repeated parameter or an unknown one fails the check.
- Object keys and list prefixes stay under `keyPrefix`.
- `x-amz-copy-source` names an object in the same bucket and under the same prefix, and only on an object `PUT`.
- A read-only mount allows no operation that changes data.
- `aws-chunked` payloads and `x-amz-*` headers outside a known list are refused.

Anything else gets a `403` response. Batch delete (`POST ?delete`) is not on the list, because its XML body could name keys outside the prefix. Only an allowlist of headers is forwarded to the upstream.

## One route for each mount

Each new mount gets a random route ID (`crypto.randomUUID()`), and with it a new hostname. The ID is also the `s3fs` `fsname`, `sandbox-s3-<ROUTE_ID>`, which is how the shim recognizes its own mounts in `/proc/self/mountinfo`.

The platform has no way to remove an outbound intercept. So `unmount()` cannot delete the route. It registers the same hostname again with a gateway in `deny` mode, which answers every request with `403`. A stale `s3fs` process, or any other process that kept the hostname, therefore loses access, and it cannot pick up a later mount's access, because a later mount uses a new hostname.

Registering a hostname that is already registered replaces its handler and uses no more capacity. So a `mount()` call that reuses an existing mount costs nothing. A container accepts at most 64 intercept targets, so each new mount uses one of 64, whether it is later unmounted or not. This is why the docs tell applications that mount and unmount many times to use a new sandbox name instead.

If `mount()` fails at any point after the shim sends the route ID, including an abort, it replaces the route with the deny gateway before it rejects. A later `mount()` for the same path reuses the route ID from the marker and registers the active gateway again.

## State in the container

The shim keeps its state under `/run/sandbox/s3-mounts`:

- A marker file for each mount path, named by a hash of the path. It records the route ID, the mount path, and the settings without credentials.
- A lock file for each mount path under `locks/`. `mount` and `unmount` hold an exclusive `flock` on it for the whole exchange with the package, so two calls for one path never interleave. The Worker needs no queue of its own.
- A support directory for each route with the `s3fs` password file and its log.

`mount` writes the marker before it sends the route ID to the package, and before it starts `s3fs`. If anything fails after that point, the marker still names the route, so a later `inspect()` shows the leftover state and a later `mount()` or `unmount()` can finish the job.

The shim reduces what it finds at a path to one of five states:

| State          | Meaning                                | `mount()` with the same settings                                       |
| -------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| `absent`       | No marker and nothing mounted          | Starts a new mount with a new route                                    |
| `unmanaged`    | Something else is mounted at the path  | Fails with a conflict                                                  |
| `incompatible` | A marker from another protocol version | Fails as incompatible                                                  |
| `stale`        | A marker, but no matching mount        | Starts `s3fs` again with the marker's route                            |
| `managed`      | A marker and its mount                 | Reuses it if FUSE is connected, and mounts again if it is disconnected |

A marker whose settings differ from the request fails with a conflict. Settings are compared after canonicalization, so equivalent requests match. `unmount` never forces or lazily unmounts. A busy filesystem fails with `S3_MOUNT_BUSY`, access stays denied, and the application can retry.

These states also make `mount()` safe to call again from a new Durable Object instance. A container and its mounts can outlive the Durable Object instance that created them. Calling `mount()` from the new instance finds the `managed` mount, keeps its route ID, and registers the route again with a gateway from the current deployment.

## Inspection

`inspect()` reports what the shim finds, and for a `stale` or `managed` mount it sends one `ListObjectsV2` request with `max-keys=1` through the route from inside the container. The gateway recognizes that request by its `sandbox-shim/1` user agent and turns the upstream response into a result in response headers, such as `usable`, `rejected-credentials`, or `unavailable`. So one call separates a missing mount, a revoked route, bad credentials, and an unreachable upstream. The report has no single `healthy` field, because which of those matter depends on the application.

## Only S3-compatible endpoints

The gateway talks to S3-compatible endpoints only. R2 works through its S3 endpoint with R2 API tokens. Translating S3 requests to an R2 binding would make the gateway a partial S3 server with its own semantics to verify, so that path is not built.

The shim always starts `s3fs` with `nomixupload`, and applications cannot set or unset it. When a command rewrites part of a large object, `s3fs` would otherwise copy the unchanged ranges as upload parts, so the parts differ in size. R2 rejects a multipart upload whose parts before the last differ in size (`InvalidPart`), and every S3-compatible provider accepts uniform parts. The cost is that such a rewrite uploads the whole object. Detecting R2 from the endpoint instead would put provider-specific behavior in a path that is otherwise provider-neutral.

## Versions

The mount request, the marker file, and the gateway props each carry protocol version `1`. The shim refuses a request from another version as incompatible, and reports a marker from another version as the `incompatible` state. The gateway answers props from another version with a `gateway-protocol` result. This version is separate from the frame version in [Shim protocol](shim-protocol.md#versioning).

## Open platform gaps

- There is no API to remove an intercept, so every new mount costs one of 64 targets for the life of the container.
- Local development under `wrangler dev` needs Wrangler and workerd releases that are not published yet, so `npm run test:s3-native-local` is not part of `npm run test:release`. See [Testing](testing.md).
