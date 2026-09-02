---
'@cloudflare/sandbox': patch
---

Make local R2 bucket mounts reliable for large files by streaming transfers, safely uploading multipart objects, and retrying serialized writes after filesystem changes settle. A prefixed local mount now matches only that directory subtree. Identical active mounts are no-ops, and interrupted mounts are replaced on the next mount call. Unmount waits up to five seconds for settled writes before cancelling stalled transfers.
