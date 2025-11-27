---
'@cloudflare/sandbox': minor
---

Optimize Docker image size and add image variants

**Breaking change in image tags:**

- `cloudflare/sandbox:<version>` is now a lean image (~600-800MB) without Python
- `cloudflare/sandbox:<version>-python` includes Python + data science packages (~1.3GB)

**If you use `runCode` with Python**, update your Dockerfile to use the `-python` variant:

```dockerfile
FROM cloudflare/sandbox:0.6.0-python
```

**What's changed:**

- Default image no longer includes Python runtime or data science packages
- Container runtime is now bundled (~200KB vs ~670MB node_modules)
- TypeScript executor consolidated with JavaScript executor
- Removed esbuild dependency (using Bun.Transpiler instead)

**What's NOT changed:**

- All SDK APIs remain the same
- JavaScript and TypeScript `runCode` work in both variants
- `exec()`, file operations, git operations all work in both variants
