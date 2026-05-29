---
'@cloudflare/sandbox': patch
---

Classify Office Open XML files such as `.xlsx` and `.docx` as binary when reading files so they are returned with base64 encoding instead of text decoding.
