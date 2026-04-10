---
'@cloudflare/sandbox': patch
---

Increase the default `gitCheckout()` clone timeout to 10 minutes so larger repositories and slower Git remotes do not fail after 2 minutes by default.
You can now override the git clone subprocess timeout per call with the `cloneTimeoutMs` option when a checkout needs more time.
