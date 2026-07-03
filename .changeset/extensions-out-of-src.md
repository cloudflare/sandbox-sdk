---
'@cloudflare/sandbox': patch
---

Move the built-in extension sources (`interpreter/`, `git/`) out of `packages/sandbox/src/` and into a top-level `extensions/` directory so it's clear which code is an extension versus core SDK. Public subpath imports (`@cloudflare/sandbox/interpreter`, `@cloudflare/sandbox/git`) and their APIs are unchanged.
