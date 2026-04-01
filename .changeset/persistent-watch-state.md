---
'@cloudflare/sandbox': patch
---

Add `checkChanges()` for apps that disconnect and reconnect later but still need to know whether files changed in the meantime.

Use the returned `version` in a later call to learn whether a path is unchanged, changed, or needs a full resync. Retained change state lasts for the current container lifetime only.
