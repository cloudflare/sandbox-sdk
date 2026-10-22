---
'@cloudflare/sandbox': patch
---

Update the container runtime to Bun 1.4.4. Bun checks certificates against its own built-in CA list, and in 1.4.4 that list no longer trusts the compromised eMudhra intermediates, so the `bun` command and `createBackup()` uploads of 10 MiB or more now reject their certificates. Bun 1.4.4 also updates Brotli to 1.2.1, which fixes CVE-2026-111497. The `-opencode` image ships OpenCode 1.19.4 or later, which also runs on Bun 1.4.4.
