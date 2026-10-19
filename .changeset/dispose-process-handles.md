---
'@cloudflare/sandbox': patch
---

Let callers release process and terminal handles with `using`. Each handle holds a Workers RPC stub, and an undisposed stub can crash `wrangler dev` when it is garbage collected. Disposing a handle never stops the process or terminal.
