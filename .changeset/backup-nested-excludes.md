---
'@cloudflare/sandbox': patch
---

Stop backups from dropping whole directories when `excludes` or `gitignore: true` match a nested path. For example, `excludes: ['.cache/foo/*/node_modules']` no longer removes all of `.cache` from the archive. A multi-component pattern such as `build/output` now matches only relative to the backup directory, while a single-component pattern such as `node_modules` still matches at any depth. Because mksquashfs does not support `**`, a pattern like `**/node_modules/.cache` now excludes only `node_modules/.cache` at the root of the backup directory; add a pattern for each nested location that must stay out of the backup.
