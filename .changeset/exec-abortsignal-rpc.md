---
'@cloudflare/sandbox': patch
---

Stop `exec()` from throwing when passed an `AbortSignal` without the
`enable_abortsignal_rpc` compatibility flag. Previously this failed with
`DataCloneError: AbortSignal serialization is not enabled.` because the signal
could not cross the Worker → Durable Object boundary. The command now runs and
a one-time warning explains how to enable cancellation:

```jsonc
// wrangler.jsonc
{
  "compatibility_flags": ["enable_abortsignal_rpc"]
}
```

With the flag set, the signal is honored as before; without it, the signal is
ignored instead of breaking the call.
