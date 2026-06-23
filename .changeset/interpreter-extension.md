---
'@cloudflare/sandbox': minor
---

The code interpreter is now an opt-in extension at `@cloudflare/sandbox/interpreter` instead of a built-in method on `Sandbox`. Its entire runtime (the process pool and the Python/JavaScript executors) ships as a sidecar that the container provisions on first use, so it is no longer compiled into the core SDK or the container image.

Attach it to your `Sandbox` subclass and call it directly as a nested namespace:

```ts
import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import { withInterpreter } from '@cloudflare/sandbox/interpreter';

export class Sandbox extends BaseSandbox<Env> {
  interpreter = withInterpreter(this);
}

const context = await sandbox.interpreter.createCodeContext({
  language: 'python'
});
const result = await sandbox.interpreter.runCode('print("hello")', { context });
```

`createCodeContext`, `runCode`, `runCodeStream`, `listCodeContexts`, and `deleteCodeContext` keep the same signatures, except `runCode()` now returns a plain `ExecutionResult` instead of an `Execution` instance. Python execution still requires the `-python` image variant.
