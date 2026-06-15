---
'@cloudflare/sandbox': minor
---

Extract code interpreter into `@cloudflare/sandbox/interpreter` extension.

The code interpreter is no longer built into the core Sandbox class. Import `withInterpreter` from the new subpath and create an interpreter instance:

```typescript
import { withInterpreter } from '@cloudflare/sandbox/interpreter';

const interpreter = withInterpreter(sandbox);
await interpreter.createContext({ language: 'python' });
await interpreter.runCode('print("hello")');
```

This removes `createCodeContext`, `runCode`, `runCodeStream`, `listCodeContexts`, and `deleteCodeContext` from `Sandbox`, `ISandbox`, and `ExecutionSession`. The `CodeInterpreter` and `InterpreterClient` classes are no longer exported from the main entry point.
