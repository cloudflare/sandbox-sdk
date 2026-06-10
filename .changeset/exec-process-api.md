---
'@cloudflare/sandbox': minor
---

Return `ExecProcess` from `exec()` for streaming and buffered access

`sandbox.exec()` and `session.exec()` now return `ExecProcess` instead of `Promise<ExecResult>`. The `ExecProcess` handle provides both streaming and buffered access to command output, aligned with the Containers SDK `ExecProcess` pattern.

Because `ExecProcess` implements `PromiseLike<ExecResult>`, existing code that awaits the result continues to work unchanged:

```ts
// Existing code — still works, no migration needed
const result = await sandbox.exec('ls -la');
console.log(result.stdout);

// Streaming — don't await, use the streams
const proc = sandbox.exec('tail -f /var/log/app.log');
for await (const chunk of proc.stdout) { ... }

// Explicit buffered
const result = await sandbox.exec('ls').output();

// Exit code only
const exitCode = await sandbox.exec('test -f /config').exitCode;
```

`execStream()` is now deprecated in favor of `exec().stdout`.
