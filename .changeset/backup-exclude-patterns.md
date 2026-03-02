---
'@cloudflare/sandbox': patch
---

Add backup exclude support so `createBackup()` can skip files and directories.
Use `exclude` for custom patterns and `excludeDefaults: true` to skip common
build and dependency paths like `node_modules`, `.git`, and `dist`.
