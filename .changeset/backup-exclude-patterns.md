---
'@cloudflare/sandbox': patch
---

Add `gitignore` and `excludes` options to `createBackup()`.

- `gitignore: true` excludes gitignored files when the directory is inside a git repo.
  If git is not installed, a warning is logged and the backup proceeds without git-based exclusions.
- `excludes: string[]` allows explicit glob patterns to exclude from the backup.
- Both default to off/empty — existing behavior is unchanged.
