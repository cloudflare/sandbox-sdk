---
'@cloudflare/sandbox': minor
---

Handle shell exits with `SessionTerminatedError`, and let the same session id recover on the next call.

```ts
import { SessionTerminatedError } from '@cloudflare/sandbox';

const session = await sandbox.createSession({ id: 'build' });

try {
  await session.exec('exit 42');
} catch (error) {
  if (error instanceof SessionTerminatedError) {
    console.log(error.exitCode); // 42
    await session.exec('echo fresh shell');
  }
}
```

If a session's shell exits, the failing call now returns `SESSION_TERMINATED`
(`HTTP 410`) with the observed exit code instead of a generic internal error.
Retrying with the same session id, or calling `createSession({ id })`, starts a
fresh session without destroying the whole sandbox. Session-local state such as
the working directory, environment variables, shell functions, and background
jobs is lost when the shell exits.
