---
'@cloudflare/sandbox': patch
---

Add first-class Git repository operations beyond clone.

You can now inspect repository state with `gitStatus()` and `gitListBranches()` (including `currentBranch` in the response), and manage local repository workflows with:

- `gitCheckoutBranch()`
- `gitCreateBranch()`
- `gitDeleteBranch()`
- `gitAdd()`
- `gitCommit()`
- `gitReset()`
- `gitRestore()`

These methods are designed for common sandboxed coding-agent workflows without requiring direct shell command construction.
