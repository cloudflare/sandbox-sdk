---
'@cloudflare/sandbox': patch
---

Stop `tunnels.get()` failing with "Tunnel recovery attempts were exhausted" when a tunnel error occurs on the RPC transport. Errors from `cloudflared` and tunnel conflicts in the container used to be treated as dropped connections, so `get()` retried and then reported recovery exhaustion instead of the real error. When `get()` gave up, it also left `cloudflared` running without a record, and every later `get()` for that port failed until the sandbox restarted. Tunnel errors now keep their code and message, `get()` stops a run before abandoning it, and a run left over on the port is stopped and replaced. Replacing a leftover run needs the matching container image.
