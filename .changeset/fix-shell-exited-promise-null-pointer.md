---
'@cloudflare/sandbox': patch
---

Fix crash when destroying a session that has an active streaming command. The stream now terminates cleanly instead of throwing a null pointer error.
