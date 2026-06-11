---
'@cloudflare/sandbox': patch
---

Surface container startup and replacement failures as `CONTAINER_UNAVAILABLE` errors when operations cannot be admitted to the container. Applications can distinguish temporary sandbox availability failures from command or transport failures and safely retry according to their own policy.
