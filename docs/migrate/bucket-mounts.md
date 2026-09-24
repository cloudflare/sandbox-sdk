# Move bucket mounts

In 0.12, `mountBucket()` mounted a bucket with `s3fs` and gave the Container the credentials, or used an R2 binding. Now `S3Mounts` from the package mounts it, and `S3Gateway` in your Worker signs each request, so the credentials stay in the Worker. [Mount S3-compatible storage](../s3-mounts.md) builds it step by step. The [artifact workspace example](../../examples/artifact-workspace) is a complete Worker.

## 1. Prepare the image and export the gateway

Install FUSE and `s3fs` beside `sandbox-shim`, and export `S3Gateway` from your Worker, as in steps [1](../s3-mounts.md#1-prepare-the-image) and [2](../s3-mounts.md#2-export-the-gateway) of the how-to.

Done when the Worker deploys with `S3Gateway` exported.

## 2. Replace `mountBucket()`

Pass the bucket, endpoint, region, and credentials in one request.

Done when `inspect()` reports a managed mount.

```ts
// 0.12
await sandbox.mountBucket("model-artifacts", "/mnt/models", {
  endpoint: "https://s3.us-east-1.amazonaws.com",
  prefix: "/production/current/",
  readOnly: true,
});

// Now
const mounts = new S3Mounts(this.ctx.container, this.ctx.exports.S3Gateway);
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
  keyPrefix: "production/current/",
  access: "read-only",
});
```

| 0.12 option                  | Now                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `endpoint`                   | `source.endpoint`. Add `source.region`.                                                                                                                |
| `prefix`                     | `keyPrefix`, without the leading `/` that 0.12 required                                                                                                |
| `readOnly`                   | `access`, which is required: `"read-only"` or `"read-write"`                                                                                           |
| `s3fsOptions`                | `s3fsOptions`, as an object instead of an array: `{ nomixupload: true }`. Options that replace the endpoint, credentials, or access mode are rejected. |
| `provider`                   | Not needed. 0.12 added `nomixupload` for `"r2"`. Pass it in `s3fsOptions` to keep that.                                                                |
| `credentials`                | `source.credentials` with `type: "static"`                                                                                                             |
| `credentialProxy`            | Not needed. Credentials always stay in the Worker. For short-lived credentials, use `type: "provider"`.                                                |
| `AWS_*` and `R2_*` variables | Read them yourself and pass them in `source.credentials`. Nothing is detected.                                                                         |

## 3. Replace R2 binding mounts

0.12 mounted an R2 binding by name, without an endpoint. `S3Gateway` does not accept a binding. Use R2's S3 endpoint with an [R2 API token](https://developers.cloudflare.com/r2/api/tokens/) instead.

Done when a file written through the mount appears in the bucket.

```ts
source: {
  type: "s3",
  endpoint: `https://${this.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  region: "auto",
  bucket: "agent-data",
  credentials: {
    type: "static",
    accessKeyId: this.env.R2_ACCESS_KEY_ID,
    secretAccessKey: this.env.R2_SECRET_ACCESS_KEY,
  },
},
```

Scope the token to the bucket, and to read-only access when the guest does not write.

## 4. Replace `localBucket`

0.12 copied files between the Container and an R2 binding during `wrangler dev`, because local Containers could not use FUSE. Local Containers can now, so use the same `S3Mounts` code in development as in production, and point it at an S3-compatible server on your machine, such as MinIO. This needs Wrangler 4.137.0 or later. Wrangler 4.131.2 does not run Durable Object Containers locally.

Done when a file written through the mount under `wrangler dev` appears in the local bucket. [Develop locally](../s3-mounts.md#develop-locally) shows the commands.

To use a real R2 bucket in development instead, give it its own R2 API token, and pass R2's S3 endpoint as in step 3.

## 5. Replace `unmountBucket()` and the mount errors

Replace `unmountBucket(path)` with `mounts.unmount(path)`. Replace catches of `BucketMountError`, `BucketUnmountError`, `InvalidMountConfigError`, `MissingCredentialsError`, and `S3FSMountError` with `SandboxS3MountError.is(cause)`, and branch on its `code`. Invalid requests throw `TypeError` before anything runs.

Done when the Worker has no imports of the 0.12 mount errors.

For the codes, see the [S3Mounts API](../s3-mounts-api.md#sandboxs3mounterror).
