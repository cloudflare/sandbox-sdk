---
'@cloudflare/sandbox': minor
---

Add lean and Python image variants to reduce Docker image size

**BREAKING CHANGE for Python users:** The default image no longer includes Python.

- `cloudflare/sandbox:<version>` - lean image without Python (~600-800MB)
- `cloudflare/sandbox:<version>-python` - full image with Python + data science packages (~1.3GB)

**Migration:** If using `CodeInterpreter.runCode()` with Python, update your Dockerfile:

```dockerfile
# Before
FROM cloudflare/sandbox:0.5.6

# After
FROM cloudflare/sandbox:0.5.6-python
```

Without this change, Python execution will fail with `PYTHON_NOT_AVAILABLE` error.
