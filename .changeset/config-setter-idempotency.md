---
'@cloudflare/sandbox': patch
---

Fix sandboxes staying alive past their configured `sleepAfter` value.

Workers that passed configuration options to `getSandbox()` on every request — `sleepAfter`, `keepAlive`, or `containerTimeouts` — could unintentionally extend sandbox lifetimes. The SDK's internal reapply path treated identical reapplied values as activity, resetting the sleep timer each time. Under sustained traffic, sandboxes would never sleep at all.

After updating, reapplying the same configuration value is a true no-op. Your `getSandbox()` calls continue to work exactly as before; sandboxes now respect their configured sleep timers regardless of how often configuration is reapplied. `baseUrl` also now survives Durable Object restart correctly — previously it could be lost after eviction.
