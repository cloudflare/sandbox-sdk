---
'@cloudflare/sandbox': patch
---

Add a `@cloudflare/sandbox/tunnels` entrypoint with helpers for sweeping abandoned named tunnels and orphaned DNS records from your Cloudflare account. Useful for long-lived deployments where Durable Object cleanup may not run before tunnel resources are abandoned (e.g. DO eviction, crashes, missed `destroy()` calls). Designed to run from a cron-triggered Worker.

```ts
import { createScheduledTunnelCleanupHandler } from '@cloudflare/sandbox/tunnels';

export default {
  scheduled: createScheduledTunnelCleanupHandler({
    staleAfterMs: 24 * 60 * 60_000
  })
};
```

```jsonc
{
  "triggers": {
    "crons": ["0 3 * * *"]
  }
}
```

The handler reads `CLOUDFLARE_API_TOKEN` from env at run time and is a no-op when the token is missing. It uses `CLOUDFLARE_TUNNEL_ACCOUNT_ID` or `CLOUDFLARE_ACCOUNT_ID` when present, otherwise it infers the account from single-account tokens. `CLOUDFLARE_ZONE_ID` is optional and is inferred when unambiguous; without a resolved zone ID, cleanup still deletes stale tunnels but skips DNS-record cleanup. Workers with unrelated cron jobs can call the returned handler from their own cron dispatch:

```ts
const tunnelCleanup = createScheduledTunnelCleanupHandler({
  staleAfterMs: 24 * 60 * 60_000
});

export default {
  async scheduled(controller, env, ctx) {
    switch (controller.cron) {
      case '0 3 * * *':
        return tunnelCleanup(controller, env, ctx);
      case '*/5 * * * *':
        ctx.waitUntil(runUnrelatedJob(env));
    }
  }
};
```

Cleanup only deletes tunnels tagged by this SDK and refuses to delete any tunnel that is missing its `metadata.sandboxId` tag, so a misconfigured token can't wipe resources created by other tools. The lower-level `sweepStale`, `listSandboxTunnels`, and `listSandboxDNSRecords` helpers are also exported for one-off audits and custom cleanup workflows.
