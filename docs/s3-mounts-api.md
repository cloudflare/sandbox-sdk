# S3Mounts API

Package: `@cloudflare/sandbox`

Exports: `S3Mounts`, `S3Gateway`, `SandboxS3MountError`, `SandboxProtocolError`, `S3MountRequest`, `S3MountInspection`, `S3MountOperationOptions`, `S3GatewayBinding`, and `S3MountOperation`.

`S3Mounts` attaches an S3-compatible bucket or prefix to a running Container. Pass `this.ctx.container` and `this.ctx.exports.S3Gateway` from a Durable Object that has a container attachment.

`S3Mounts` does not start or destroy the Container. Mount operations call `container.exec()` and throw if the Container is not running. The image must include FUSE, `s3fs`, and `/usr/local/bin/sandbox-shim`. Turn on `nodejs_compat`. Re-export `S3Gateway` from the Worker module.

For the walkthrough, see [Mount S3-compatible storage](s3-mounts.md).

## `new S3Mounts(container, gateway)`

Construct one helper for one Container.

## `mount(request, options?): Promise<void>`

Create the mount, reuse a matching mount, or repair leftover state from a failed attempt.

- An absent path is created
- A matching managed mount is reused
- Matching leftover state is repaired
- A different filesystem or configuration throws `S3_MOUNT_CONFLICT`

Reuse does not consume another Container intercept. A new mount does.

If leftover state exists and the next request needs different settings, call `unmount()` first.

`S3Mounts` does not retry `mount()`, `inspect()`, `unmount()`, intercept updates, or credential-provider calls. Retry in the application only after you inspect the current state.

`s3fs` may retry the S3 requests created by filesystem operations. Version 1.93 defaults to 5 retries, a 300s connection timeout, a 120s read/write timeout, and a 900s metadata cache. Set `retries`, `connect_timeout`, `readwrite_timeout`, and `stat_cache_expire` through `s3fsOptions` when you need a specific policy. Those options are part of the mount configuration. Change them only after a completed `unmount()`.

### `S3MountRequest`

| Field                | Type                                          | Description                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mountPath`          | `string`                                      | Normalized absolute path. Not `/`. Must not overlap `/proc/self/mountinfo`, `/run/sandbox/s3-mounts`, or `/usr/local/bin/sandbox-shim`                                                                              |
| `source.type`        | `"s3"`                                        | Source kind                                                                                                                                                                                                         |
| `source.endpoint`    | `string`                                      | HTTP or HTTPS origin with no credentials, path, query, or fragment                                                                                                                                                  |
| `source.region`      | `string`                                      | S3 region                                                                                                                                                                                                           |
| `source.bucket`      | `string`                                      | Bucket name                                                                                                                                                                                                         |
| `source.credentials` | object                                        | Worker-held static credentials or a credential provider                                                                                                                                                             |
| `keyPrefix`          | `string`                                      | Optional object-key prefix. A non-empty value ends in `/`                                                                                                                                                           |
| `access`             | `"read-only" \| "read-write"`                 | Required guest access                                                                                                                                                                                               |
| `s3fsOptions`        | `Record<string, string \| number \| boolean>` | Extra `s3fs` flags. `true` emits a bare flag, `false` omits it, and other values emit `name=value`. Options that replace the intercept, credentials, access mode, process mode, or filesystem identity are rejected |

Static credentials:

| Field             | Type       | Description            |
| ----------------- | ---------- | ---------------------- |
| `type`            | `"static"` | Credential kind        |
| `accessKeyId`     | `string`   | Access key             |
| `secretAccessKey` | `string`   | Secret key             |
| `sessionToken`    | `string`   | Optional session token |

Provider credentials:

| Field     | Type                     | Description                                         |
| --------- | ------------------------ | --------------------------------------------------- |
| `type`    | `"provider"`             | Credential kind                                     |
| `fetcher` | `Pick<Fetcher, "fetch">` | Fetcher called for each authorized upstream request |

The gateway sends `GET https://credentials.sandbox.internal/` with `Accept: application/json`. Return at most 16 KiB of JSON:

```ts
return Response.json({
  accessKeyId: temporaryCredentials.accessKeyId,
  secretAccessKey: temporaryCredentials.secretAccessKey,
  sessionToken: temporaryCredentials.sessionToken,
  expiresAt: temporaryCredentials.expiration.getTime(),
});
```

`expiresAt` is a Unix timestamp in milliseconds and must be in the future. The package does not cache credentials and does not retry provider failures. Grant only the configured bucket and prefix.

This release does not accept an R2 binding. Use the R2 S3 endpoint and S3 credentials.

## `inspect(mountPath, options?): Promise<S3MountInspection>`

Report the current path without changing it.

`inspect()` waits for an in-flight `mount()` or `unmount()` on the same path, then reads guest mount state. That snapshot can include a `statfs` call, which can block if the filesystem is unresponsive. After that snapshot, the lock is released before the gateway probe. Gateway evidence can therefore be newer than the guest snapshot.

There is no package deadline. Pass `signal` when the application needs one. An aborted inspect throws the abort reason.

`inspect()` sends a prefix-scoped list request. Credentials that can read one object but cannot list the prefix report an upstream access rejection.

## `unmount(mountPath, options?): Promise<void>`

Stop new access, then unmount the path.

An absent path succeeds. This never force-unmounts or lazy-unmounts.

If intercept denial fails, the filesystem stays mounted and the error is preserved. If the filesystem is busy, the intercept stays denied and the leftover state remains for retry.

After denial:

- New requests on that intercept return HTTP 403 before credentials are resolved
- A request already in flight may complete
- Cached guest or `s3fs` data can remain readable
- A denied read may fail, return empty or truncated data, or return cached data
- Do not depend on a specific errno or exit status

Calling `mount()` again does not clear `s3fs` caches created while access was denied. Coherent reads resume after the cache expires, after a completed `unmount()` and new `mount()`, or after you start a new Container.

`unmount()` does not remove the Container intercept. A later `mount()` with new settings creates another intercept. Those intercepts share a finite Container budget with every other outbound intercept. Repeated mount and unmount cycles in the same Container eventually fail. For a new job or tenant, use a new sandbox name. Native intercept failures propagate unchanged.

Canceling `mount()` or `unmount()` after intercept setup can leave a healthy filesystem with access denied. Call `mount()` with the same request to restore access, or call `unmount()` again.

### `S3MountOperationOptions`

| Field    | Type          | Description                                            |
| -------- | ------------- | ------------------------------------------------------ |
| `signal` | `AbortSignal` | Passed through to `container.exec()` and inspect waits |

Abort reasons, native `exec()` failures, and transport failures are not wrapped.

## `S3MountInspection`

| `attachment.status` | Extra fields                       | Meaning                                          |
| ------------------- | ---------------------------------- | ------------------------------------------------ |
| `absent`            | none                               | No managed mount                                 |
| `unmanaged`         | `filesystemType`                   | Another filesystem owns the path                 |
| `incompatible`      | none                               | Leftover state uses an unsupported protocol      |
| `stale`             | `configuration`, `gateway`         | Leftover managed state without a live filesystem |
| `managed`           | `configuration`, `fuse`, `gateway` | Live managed mount                               |

`fuse.status` is `connected`, `disconnected`, or `indeterminate`.

`gateway.status` is `unreachable`, `error`, or `reachable`. A reachable gateway includes `upstream.status`: `usable`, `unavailable`, or `rejected`.

## Credentials and guest access

Real access keys stay in the Worker. The Container receives dummy credentials because `s3fs` requires a key pair. The gateway does not authenticate that pair. Any process in the Container that can reach the mounted path can use the configured bucket and prefix.

The gateway checks the intercept host, bucket, prefix, access mode, HTTP method, S3 operation, and S3 headers before it re-signs a request. Unknown and administrative operations are rejected. The guest `Authorization` header is not forwarded.

A compromised guest can still perform every allowed operation in that prefix. Use read-only mounts where possible. Narrow IAM independently of the gateway. Do not share credentials across tenants.

## Filesystem behavior

The mounted path keeps S3 and `s3fs` behavior:

- Directories are inferred from object keys and may need marker objects
- Rename is generally copy then delete
- File locking, hard links, ownership, permissions, and atomic replacement are not POSIX contracts
- Caching and consistency depend on `s3fs` and the backend
- Interrupted writes and multipart uploads can leave remote work to clean up

The release tests use MinIO. Other S3-compatible services can differ. Verify the operations you need against the backend you run.

## `SandboxS3MountError`

A classifiable mount failure.

| Field       | Type                                | Description                    |
| ----------- | ----------------------------------- | ------------------------------ |
| `name`      | `"SandboxS3MountError"`             | Error name                     |
| `code`      | `SandboxS3MountErrorCode`           | Error code                     |
| `operation` | `"mount" \| "inspect" \| "unmount"` | Failed call                    |
| `path`      | `string`                            | Path you passed                |
| `detail`    | `string`                            | Detail from the shim or helper |

| Code                    | Meaning                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `S3_MOUNT_CONFLICT`     | Another filesystem or configuration owns the path          |
| `S3_MOUNT_BUSY`         | Normal unmount reported that the mount is in use           |
| `S3_MOUNT_FAILED`       | `s3fs`, FUSE, probing, or another managed operation failed |
| `S3_MOUNT_INCOMPATIBLE` | Leftover guest state uses an unsupported protocol          |

`SandboxS3MountError.is(cause)` recognizes local and JSRPC values. It is not a public constructor.

Malformed shim exchanges throw `SandboxProtocolError`. Input validation throws `TypeError`.
