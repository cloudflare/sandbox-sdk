---
'@cloudflare/sandbox': minor
---

Add stdin support to exec() for passing arbitrary input to commands without shell injection risks. Enable with `stdin` option: `sandbox.exec('cat', { stdin: 'hello world' })`.
