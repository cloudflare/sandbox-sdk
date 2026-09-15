# Artifact workspace

Deploy this Worker to process objects in a job-scoped S3 prefix from an isolated Container. Each
sandbox name maps to one Durable Object and the prefix `sandboxes/<name>/`.

The example writes `input.txt`, computes its SHA-256 digest inside the Container, and writes
`output.sha256` through the same mount. Done when the digest response matches the input.

## Configure the bucket

Edit `S3_ENDPOINT`, `S3_REGION`, and `S3_BUCKET` in `wrangler.jsonc`. The endpoint must be an
origin-only URL for an S3-compatible API.

Add credentials as Worker secrets:

```sh
npx --yes wrangler@4.131.2 secret put S3_ACCESS_KEY_ID \
  --config examples/artifact-workspace/wrangler.jsonc
npx --yes wrangler@4.131.2 secret put S3_SECRET_ACCESS_KEY \
  --config examples/artifact-workspace/wrangler.jsonc
```

Grant only bucket-list access for `sandboxes/*` and object access under that prefix. The real
credentials remain in the Worker. The Container receives only route-local dummy credentials.

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

Unmount while keeping the Container, or unmount and destroy the execution:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/job-1/mount"
curl --request DELETE "$WORKER_URL/sandboxes/job-1/execution"
```

The next input or digest request remounts the same prefix. Each completed unmount leaves its route
installed in deny mode, so prefer execution reset over repeated in-place mount/unmount cycles for
high-churn jobs. S3 remains object storage: do not depend on POSIX locking, atomic rename, or
immediate cache coherence. See
[Mount S3-compatible storage](../../docs/s3-mounts.md) for lifecycle, retry, cache, revocation, and
trust-boundary details.

Authenticate these routes in production and derive the sandbox name from the authenticated job or
tenant. Prefer read-only mounts for workflows that do not produce artifacts.

The pinned public Wrangler deploys this example, but local development currently requires a
workers-sdk/workerd pair with named Durable Object images and FUSE support. Repository maintainers
can validate that path with `npm run test:s3-native-local`.
