---
'@cloudflare/sandbox': minor
---

Add the experimental `@cloudflare/sandbox/extensions` framework for attaching higher-level, opt-in APIs to a Sandbox subclass. An extension runs inside the Sandbox and can bring its own container sidecar — a self-contained program shipped as a `.tgz` that starts on first use — so features like the code interpreter live outside the core SDK.

Attach a shipped extension to your Sandbox subclass and call it directly:

```ts
import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import { withInterpreter } from '@cloudflare/sandbox/interpreter';

export class Sandbox extends BaseSandbox<Env> {
  interpreter = withInterpreter(this);
}

const context = await sandbox.interpreter.createCodeContext({ language: 'python' });
const result = await sandbox.interpreter.runCode('print("hello")', { context });
```

To author your own, extend `SandboxExtension` and export a `withYourExtension(sandbox)` factory; sidecar-backed extensions call their typed methods through `this.withSidecar(...)`. This is experimental — distributing third-party extensions over npm is not wired up yet.
