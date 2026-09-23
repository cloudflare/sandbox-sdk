---
'@cloudflare/sandbox': patch
---

Fix `File exists` errors when git or other tools recreate files in a directory restored with `restoreBackup()`, such as running `git reset --hard` while a dev server watches the project.
