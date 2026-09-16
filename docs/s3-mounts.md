# Mount S3-compatible storage

Give a running Container a filesystem path into an S3 bucket or prefix.

Use this for a few long-lived mounts in one job or session. Calling `mount()` again with the same settings reuses the existing mount. `unmount()` stops access and unmounts the path. It does not fully clean up the Container's intercept. For a new job or tenant, use a new sandbox name.

The [artifact workspace example](../examples/artifact-workspace) is the full Worker.

This is not a POSIX filesystem. Do not use it for locking, atomic rename, or workspace persistence. For method fields and error codes, see [S3Mounts API](s3-mounts-api.md).

## 1. Prepare the image

The image needs FUSE, `s3fs`, and `/usr/local/bin/sandbox-shim`.

Done when your image copies `sandbox-shim` and installs `fuse3` plus `s3fs`.

```sh
npm run shim:build
```

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

Local Container images must declare a port. This path uses `Container.exec()`, not port `8080`.

Use the same image locally and in production so `s3fs` behavior does not drift.

Local FUSE needs Docker in a virtual machine, or rootless Linux with `/dev/fuse`. Rootful Linux Docker does not support local FUSE by default. See [FUSE support during local development](https://developers.cloudflare.com/containers/guides/local-dev/#fuse-support).

Confirm your Wrangler version exposes `this.ctx.container`. An image build is not enough.

Keep `nodejs_compat` enabled, as shown in [Run a Linux task](get-started.md).

## 2. Export the gateway

Re-export `S3Gateway` from the Worker module so `ctx.exports.S3Gateway` exists.

Done when the Durable Object can construct `S3Mounts`.

```ts
import { S3Mounts } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

export { S3Gateway } from "@cloudflare/sandbox";

export class WorkspaceSandbox extends DurableObject<Env> {
  readonly mounts = new S3Mounts(this.requireContainer(), this.ctx.exports.S3Gateway);
}
```

Do not expose `S3Gateway` as an HTTP route. Do not add it to the Wrangler `exports` object used for Durable Objects and Containers.

Keep real S3 credentials in the Worker. The Container never receives them.

## 3. Mount a prefix

Start the Container, then mount one prefix.

Done when `inspect()` reports a managed mount.

```ts
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
```

The endpoint must be an HTTP or HTTPS origin with no credentials, path, query, or fragment. This release does not accept an R2 binding. Use the R2 S3 endpoint and S3 credentials.

`access` is required. Use `"read-only"` unless the guest must write objects.

`S3Mounts` does not start, monitor, or destroy the Container.

## 4. Confirm the mount

Inspect the path, then read or write through it.

Done when `inspect()` shows a managed attachment and your file operation succeeds.

```ts
const state = await mounts.inspect("/mnt/models");
```

Use an `AbortSignal` if the application needs a deadline:

```ts
const state = await mounts.inspect("/mnt/models", {
  signal: AbortSignal.timeout(15_000),
});
```

## 5. Unmount when the job is done

Call `unmount()` before you destroy a running Container.

Done when `inspect()` reports that the path is absent.

```ts
await mounts.unmount("/mnt/models");
```

If unmount returns `S3_MOUNT_BUSY`, stop processes that hold the path and retry. If the guest still needs the files, call `mount()` with the same request first.

## After the first success

Keep the mount up for the life of the job. Do not mount and unmount on every request.

Calling `mount()` again with the same settings reuses the existing mount.

`unmount()` stops new access and unmounts the path. The Container still keeps that intercept. Repeated mount and unmount cycles in the same Container eventually fail. For a new job or tenant, use a new sandbox name.

Authenticate in production. Derive the sandbox name from the authenticated job or tenant.

Prefer read-only mounts when the guest does not need to write.

S3 and `s3fs` are not a normal filesystem:

- Rename is usually copy then delete
- File locking and atomic replacement are not POSIX contracts
- Cached reads can remain after unmount
- Interrupted writes can leave remote objects to clean up

## Next steps

- [S3Mounts API](s3-mounts-api.md)
- [Artifact workspace example](../examples/artifact-workspace)
- [About sandboxes](about-sandboxes.md)
