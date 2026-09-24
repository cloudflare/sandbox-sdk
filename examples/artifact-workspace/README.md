# Artifact workspace

Deploy this Worker to process objects in a job-scoped S3 prefix from an isolated Container. Each sandbox name maps to one Durable Object and the prefix `sandboxes/<name>/`.

The example writes `input.txt`, computes its SHA-256 digest inside the Container, and writes `output.sha256` through the same mount. Done when the digest response matches the input.

## Configure the bucket

Edit `S3_ENDPOINT`, `S3_REGION`, and `S3_BUCKET` in `wrangler.jsonc`. The endpoint must be an HTTP or HTTPS origin for an S3-compatible API.

Add credentials as Worker secrets:

```sh
npx --yes wrangler@4.137.0 secret put S3_ACCESS_KEY_ID \
  --config examples/artifact-workspace/wrangler.jsonc
npx --yes wrangler@4.137.0 secret put S3_SECRET_ACCESS_KEY \
  --config examples/artifact-workspace/wrangler.jsonc
```

Grant only list access for `sandboxes/*` and object access under that prefix. Keep the real credentials in the Worker.

## Deploy and process an artifact

```sh
npm run example:artifact-workspace:deploy
```

Write an input for `job-1`:

```sh
printf 'artifact input\n' | \
  curl --request PUT --data-binary @- \
  "$WORKER_URL/sandboxes/job-1/input"
```

Process it:

```sh
curl --request POST "$WORKER_URL/sandboxes/job-1/digest"
```

Read the existing result or inspect the mount:

```sh
curl "$WORKER_URL/sandboxes/job-1/digest"
curl "$WORKER_URL/sandboxes/job-1/mount"
```

Unmount, or unmount and destroy the Container:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/job-1/mount"
curl --request DELETE "$WORKER_URL/sandboxes/job-1/execution"
```

The next input or digest request mounts the same prefix again.

Keep one sandbox name for one job. For a new job or tenant, use a new sandbox name. Do not mount and unmount repeatedly in the same Container.

S3 is object storage. Do not depend on POSIX locking, atomic rename, or immediate cache coherence. See [Mount S3-compatible storage](../../docs/s3-mounts.md).

Authenticate these routes in production and derive the sandbox name from the authenticated job or tenant. Prefer read-only mounts when the guest does not need to write.

To run this example under `wrangler dev` against a local S3 server, see [Develop locally](../../docs/s3-mounts.md#develop-locally).
