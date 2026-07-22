# Sandbox reconstruction harness

This opt-in suite uses Wrangler's `createTestHarness()` with the real Sandbox
container image:

```bash
npm run test:harness -w @cloudflare/sandbox
```

It requires a running Docker daemon. The suite characterizes Durable Object
in-memory state across explicit eviction and a coordinated local Worker reload,
contrasts dynamic environment variables with storage-backed `sleepAfter`, and
verifies that a fresh container process can execute afterward.

The suite is intentionally not part of the ordinary unit-test job because it
builds the full container image. It also does not model production rollout
propagation, an in-flight container operation, runtime-incarnation fencing, or
stale-handle behavior. Miniflare cannot evict a Sandbox DO after its local
container has active references, so privileged E2E remains authoritative for
those lifecycle paths.
