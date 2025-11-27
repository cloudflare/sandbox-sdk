---
'@cloudflare/sandbox': minor
---

Add lean and Python image variants to reduce Docker image size

- `cloudflare/sandbox:<version>` - lean image without Python (~600-800MB)
- `cloudflare/sandbox:<version>-python` - full image with Python + data science packages (~1.3GB)

If using Python with `runCode`, update your Dockerfile to use the `-python` variant.
