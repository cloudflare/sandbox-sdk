---
'@cloudflare/sandbox': minor
---

Extract code interpreter into `@cloudflare/sandbox/interpreter` extension.

The code interpreter is no longer built into the core Sandbox class. The `interpreter` API is unchanged (`createContext`, `runCode`, `runCodeStream`, `listContexts`, `deleteContext`), but `withInterpreter` now talks to the container over RPC, so it must be bound to a Sandbox instance (the `this` of a subclass) rather than the stub returned by `getSandbox()`:

```typescript
import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import { withInterpreter } from '@cloudflare/sandbox/interpreter';

export class Sandbox extends BaseSandbox<Env> {
  interpreter = withInterpreter(this);

  async run() {
    await this.interpreter.createContext({ language: 'python' });
    return this.interpreter.runCode('print("hello")');
  }
}
```

This removes `createCodeContext`, `runCode`, `runCodeStream`, `listCodeContexts`, and `deleteCodeContext` from `Sandbox`, `ISandbox`, and `ExecutionSession`. The `CodeInterpreter` and `InterpreterClient` classes are no longer exported from the main entry point.
