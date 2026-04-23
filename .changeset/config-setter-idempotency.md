---
'@cloudflare/sandbox': patch
---

Fix sandboxes staying alive past their configured `sleepAfter` value.

Workers that passed configuration options such as `sleepAfter` to `getSandbox()` on every request could unintentionally extend sandbox lifetimes. Each cold Worker isolate rebuilt its configuration cache from scratch and re-applied the same options to the Sandbox Durable Object, which treated the no-op reapply as activity and reset the sleep timer. With enough traffic, the sandbox never slept.

Re-applying identical configuration values (`sleepAfter`, `keepAlive`, container startup timeouts) is now a no-op with no timer reset. A related issue is fixed for `baseUrl`: it now survives Durable Object restart correctly (previously it could be silently overwritten after eviction). Multi-field configuration is applied atomically so a partial write failure cannot leave inconsistent state.

No API changes. `getSandbox(ns, id, { sleepAfter: '10m' })` and other option patterns behave the same from the caller's perspective; they just no longer accumulate silent side effects as Worker isolates recycle.
