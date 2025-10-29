---
"@cloudflare/sandbox": patch
---

Fix type generation

We inline types from `@repo/shared` so that it includes the types we reexport. Fixes #165
