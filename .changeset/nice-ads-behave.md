---
'@cloudflare/sandbox': patch
---

Add shallow clone support via `depth` option in `gitCheckout()`. Use `depth: 1` to clone only the latest commit, reducing clone time and disk usage for large repositories.
