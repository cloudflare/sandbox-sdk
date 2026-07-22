---
'@cloudflare/sandbox': minor
---

Add the experimental `@cloudflare/sandbox/extensions` helpers for optional higher-level APIs on a Sandbox subclass. An extension can ship its own helper program as a `.tgz` sidecar that starts on first use, so features like the code interpreter stay out of the core SDK.

Attach a shipped extension and call it directly:

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

To write your own, extend `SandboxExtension` and export a `withYourExtension(sandbox)` helper. Sidecar-backed extensions call their methods through `this.withSidecar(...)`. This is experimental; publishing third-party extensions on npm is not set up yet.
