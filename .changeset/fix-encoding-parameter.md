---
'@cloudflare/sandbox': patch
---

Fix encoding parameter handling in file operations to enable MIME auto-detection. Previously, SDK and container handlers added default 'utf8' encoding, preventing MIME-based detection of binary files. Now encoding parameter is passed through as-is, allowing automatic detection when not explicitly specified.
