---
'@cloudflare/sandbox': patch
---

Add `useGitignore: true` to `createBackup()` to exclude gitignored files
when the target directory is inside a git repository.
By default, gitignored files are included in backups.
