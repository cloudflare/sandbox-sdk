---
'@cloudflare/sandbox': patch
---

Update `createBackup()` to respect `.gitignore` by default when the target
directory is inside a git repository.
Use `useGitignore: false` to opt out and include gitignored files in backups.
