---
'@cloudflare/sandbox': patch
---

Recover `restoreBackup()` when the sandbox runtime is replaced mid-restore. Restore is fenced by sandbox lifetime and runtime identity and retried boundedly when the runtime changes during the operation; if recovery is exhausted it surfaces as a structured `OPERATION_INTERRUPTED` error instead of a generic 500. Restores are not retried across `destroy()`.
