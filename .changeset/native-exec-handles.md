---
'@cloudflare/sandbox': minor
---

Make `exec()` an argv-only, launch-oriented API that returns a recoverable,
runtime-local process handle with a numeric PID, status, replayable output and
logs, waits, and numeric signal control. Process discovery does not wake a
missing runtime, and stale handles fail after runtime replacement. Remove the
snapshot, interrupt, and terminate process APIs; shell execution must be
explicit, streams are not attached implicitly, and wait or stream cancellation
is local to the caller.
