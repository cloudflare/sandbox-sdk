---
'@cloudflare/sandbox': patch
---

Add `sandbox.getContainerPlacementId()` to retrieve the Cloudflare placement ID
observed for the underlying container.

The placement ID identifies the current container placement and changes when
the container is replaced by the platform. Compare the returned value against
a stored value to detect container replacement and trigger reconciliation.

The placement ID is captured during the session-create handshake and cached
in Durable Object storage, so reads are cheap and do not require a healthy
container. A fresh placement ID is captured on each subsequent handshake,
so a replacement is reflected the next time the sandbox is used.

Returns `undefined` when no session-create handshake has been observed yet on
this sandbox — call any method that triggers session creation (such as
`exec()`) first. Returns `null` when a handshake has completed but the
container's `CLOUDFLARE_PLACEMENT_ID` environment variable is not set, such as
in local development with wrangler.

```ts
await sandbox.exec('true'); // ensures the handshake has run
const containerPlacementId = await sandbox.getContainerPlacementId();
if (
  typeof containerPlacementId === 'string' &&
  containerPlacementId !== lastKnownPlacementId
) {
  // Container was replaced — reconcile state
}
```
