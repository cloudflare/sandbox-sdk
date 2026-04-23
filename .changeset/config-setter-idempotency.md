---
'@cloudflare/sandbox': patch
---

Fix sandboxes staying alive past their configured `sleepAfter` value.

Workers that passed configuration options to `getSandbox()` on every request (`sleepAfter`, `keepAlive`, or `containerTimeouts`) could unintentionally extend sandbox lifetimes. The SDK's internal reapply path treated identical reapplied values as activity, resetting the sleep timer each time. Under sustained traffic, sandboxes would never sleep at all.

After updating, reapplying the same configuration value is a true no-op. Your `getSandbox()` calls continue to work exactly as before; sandboxes now respect their configured sleep timers regardless of how often configuration is reapplied.

This release also removes the unused `baseUrl` option from `SandboxOptions`, along with the `setBaseUrl` RPC method on the Sandbox Durable Object. The option had no effect on runtime behavior; preview URLs are driven by the `hostname` passed to preview-URL APIs. If you were setting `baseUrl` on `getSandbox()`, you can safely remove it. Directly invoking the undocumented `setBaseUrl` RPC method will now error.
