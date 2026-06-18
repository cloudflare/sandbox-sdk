---
'@cloudflare/sandbox': minor
---

The code interpreter is now an opt-in extension at `@cloudflare/sandbox/interpreter` instead of a built-in method on `Sandbox`. Its entire runtime (the process pool and the Python/JavaScript executors) ships as a sidecar that the container provisions on first use, so it is no longer compiled into the core SDK or the container image.

Attach it to your `Sandbox` subclass and expose the methods you need:

```ts
import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import { withInterpreter } from '@cloudflare/sandbox/interpreter';

export class Sandbox extends BaseSandbox<Env> {
  interpreter = withInterpreter(this);

  createCodeContext(options?) {
    return this.interpreter.createCodeContext(options);
  }
  async runCode(code: string, options?) {
    return (await this.interpreter.runCode(code, options)).toJSON();
  }
}
```

The interpreter API (`createCodeContext`, `runCode`, `runCodeStream`, `listCodeContexts`, `deleteCodeContext`) and its types are unchanged — they now live on the extension. If you used `sandbox.runCode(...)` directly, add the extension and the thin delegate methods above. Python execution still requires the `-python` image variant.
