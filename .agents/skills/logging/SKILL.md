---
name: logging
description: Use when adding logs, debugging, or working with the Logger across the SDK and container runtime. Covers the constructor-injection pattern, child loggers, env-var configuration, and test mocking. (project)
---

# Logging

## Pattern: Explicit Constructor Injection

Loggers are passed explicitly via constructor injection throughout the codebase. There is no global/ambient logger.

```typescript
import type { Logger } from '@repo/shared';

class MyService {
  constructor(private logger: Logger) {}

  async doWork(context: WorkContext) {
    const childLogger = this.logger.child({ operation: 'work' });
    childLogger.info('Working', { context });
  }
}
```

### Child loggers

Use `logger.child({ ... })` to attach structured context that will appear on every log line from that child. Prefer child loggers at the boundary of a unit of work (request, operation, session) rather than re-passing context on every call.

## Configuration

Two environment variables, both read once at startup:

| Var                  | Values                                 | Purpose               |
| -------------------- | -------------------------------------- | --------------------- |
| `SANDBOX_LOG_LEVEL`  | `debug` \| `info` \| `warn` \| `error` | Minimum level emitted |
| `SANDBOX_LOG_FORMAT` | `json` \| `pretty`                     | Output format         |

Use `json` in production (machine-parseable) and `pretty` for local dev.

## In Tests

Use `createNoOpLogger()` from `@repo/shared` to silence logging in tests:

```typescript
import { createNoOpLogger } from '@repo/shared';

const service = new MyService(createNoOpLogger());
```

Don't construct real loggers in unit tests — they add noise and can mask real failures with log output.

## When Adding Logs

- Log at **info** for significant lifecycle events (operation started/completed)
- Log at **debug** for fine-grained tracing (intermediate state)
- Log at **warn** for recoverable anomalies
- Log at **error** for failures that surface to the caller; include the error object as structured context: `logger.error('Failed', { err })`
- Pass structured context as the second argument, not via string interpolation

## Never Log Caller Data

Logs never contain data the caller passes through the SDK: command text, argument values, environment variable values, stdout/stderr, file contents, or request bodies. Commands and output can carry secrets anywhere, so no redaction pattern makes them safe. This holds at every level, including debug, and for plain `logger.*` calls as well as `logCanonicalEvent()`.

Describe the operation instead: IDs (`processId`, `commandId`, `sessionId`), outcome, `exitCode`, `durationMs`, sizes and lengths (`sizeBytes`, `stdoutLen`, `stderrLen`), file paths and ports, and names the SDK chose (event names, environment variable keys). `sandbox.exec` also logs `argv0`, the executable name, which is low-risk and says what ran; argument values stay out. `CanonicalEventPayload` types `command` and `stderrPreview` as `never`; keep new fields to the same rule. Callers who want command text in their logs log it in their own Worker.

`redactCommand()` is for text the SDK builds and cannot avoid logging, such as error messages and git URLs. It does not make caller data safe to log.
