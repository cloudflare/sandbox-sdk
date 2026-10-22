---
"@cloudflare/sandbox": patch
---

Fix `Files.readDirectory()` dropping a leading U+FEFF from entry names. Names that start with U+FEFF now come back unchanged, so passing them to `stat()` or other file operations finds the entry.
