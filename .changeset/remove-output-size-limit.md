---
'@cloudflare/sandbox': patch
---

Remove output size limit for command execution

The 10MB output size limit that was intended to prevent OOM attacks has been removed. This limit was too restrictive for legitimate use cases like reading large media files. Developers are now trusted to manage their own resource usage and handle potential OOM situations.
