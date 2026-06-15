# Extensible Sandbox Design Proposal
---

## 1. Problem

The `Sandbox` class (`packages/sandbox/src/sandbox.ts`) is ~7,500 lines. Every user pays the type surface and import cost of every capability, even if they only need `exec` + `readFile`. Adding a new capability requires editing the `Sandbox` class, `ISandbox` interface, `getSandbox()` proxy, and the `ExecutionSession` wrapper **four coordination points**.

Three capabilities are good candidates for immediate extraction:

| Capability       | SDK lines (in Worker bundle)                                           | Container lines (in Docker image)                                                  |
| ------------------| ------------------------------------------------------------------------| ------------------------------------------------------------------------------------|
| Git              | `GitClient` (105) + ~20 lines in `Sandbox`                             | `GitService` (514), `GitManager` (264), `GitHandler` (69), `GitRPCAPI` (~33)       |
| Code interpreter | `InterpreterClient` (344) + `CodeInterpreter` (146) + ~80 in `Sandbox` | `InterpreterService` (439), `InterpreterHandler` (222), `InterpreterRPCAPI` (~140) |
| Terminal (PTY)   | `proxyTerminal` (30) + ~30 in `Sandbox`/`getSandbox`                   | `PtyWebSocketHandler` (184), `pty.ts` (124)                                        |

Critically, `SandboxClient` eagerly imports and instantiates `GitClient` and `InterpreterClient` in its constructor every Worker bundle pays for them even if they're never used. Just moving the thin API delegate methods (~130 lines) into plugins while leaving the clients in core wouldn't actually slim anything.

---

## 2. Technical Context

- **DO class hierarchy is fixed at deploy time.** No dynamic mixins on Durable Objects.
- **`getSandbox()` is the consumer entry point.** It wraps a DO stub with a Proxy — we can enrich the return type here.
- **Most DO methods just delegate to `this.client.*`.** The DO is an orchestration layer, not the execution layer. This means plugin methods can run in the Worker context without losing anything.
- **Container-side services are already modular.** The DI container in `core/container.ts` registers handlers independently — no container changes needed for extraction.

---

## 3. Design Principles

1. **No internal coupling.** Extensions depend only on the sandbox's public API (`exec`, `containerFetch`, `fetch`, `createSession`). If an extension needs something that isn't public, make it public on `Sandbox` first.
2. **No stub mutation.** The stub returned by `getSandbox()` is already wrapped in a Proxy. Extensions return their own objects — they don't patch the stub.
3. **Namespaced APIs.** Extensions return namespaced objects: `git.checkout(...)`, `interpreter.runCode(...)`. Clean boundary between core and extensions, matches industry patterns.

---

## 4. Proposed API

Each extension is a factory function that takes a sandbox (stub or instance) and returns a namespaced capability object. The same function works in both the Worker context and inside a Sandbox subclass:

### Usage

```typescript
import { getSandbox } from '@cloudflare/sandbox';
import { withGit } from '@cloudflare/sandbox/git';
import { withInterpreter } from '@cloudflare/sandbox/interpreter';
import { withTerminal } from '@cloudflare/sandbox/terminal';

// Caller-side (Worker)
const sandbox = getSandbox(env.MySandbox, 'my-sandbox');
const git = withGit(sandbox);
const interpreter = withInterpreter(sandbox);

await sandbox.exec('echo hello');
await git.checkout('https://github.com/user/repo');
await interpreter.runCode('print("hello")', { language: 'python' });
```

```typescript
// Subclass-side (DO) — same function, same interface
export class MySandbox extends Sandbox<Env> {
  interceptHttps = true;
  git = withGit(this);
  interpreter = withInterpreter(this);

  async onTaskReceived(task: string) {
    await this.git.checkout('https://github.com/user/repo');
    const result = await this.interpreter.runCode(task);
    return result;
  }
}
```

### Implementation

Extensions depend only on the sandbox's public methods. They don't know about `SandboxClient`, `ContainerControlClient`, or any internal:

```typescript
// @cloudflare/sandbox/git

export interface Git {
  checkout(repoUrl: string, options?: GitCheckoutOptions): Promise<GitCheckoutResult>;
}

export function withGit(sandbox: SandboxLike): Git {
  return {
    async checkout(repoUrl, options) {
      // Uses only the public sandbox API
      const response = await sandbox.containerFetch(
        new Request('http://localhost:3000/api/git/checkout', {
          method: 'POST',
          body: JSON.stringify({ repoUrl, ...options }),
        })
      );
      return response.json();
    },
  };
}
```

```typescript
// @cloudflare/sandbox/interpreter

export interface Interpreter {
  createContext(options?: CreateContextOptions): Promise<CodeContext>;
  runCode(code: string, options?: RunCodeOptions): Promise<ExecutionResult>;
  runCodeStream(code: string, options?: RunCodeOptions): Promise<ReadableStream>;
  listContexts(): Promise<CodeContext[]>;
  deleteContext(contextId: string): Promise<void>;
}

export function withInterpreter(sandbox: SandboxLike): Interpreter {
  return {
    async createContext(options) { /* sandbox.containerFetch('/api/contexts', ...) */ },
    async runCode(code, options) { /* sandbox.containerFetch('/api/execute/code', ...) */ },
    async runCodeStream(code, options) { /* sandbox.containerFetch('/api/execute/code', ...) */ },
    async listContexts() { /* sandbox.containerFetch('/api/contexts', ...) */ },
    async deleteContext(id) { /* sandbox.containerFetch(`/api/contexts/${id}`, ...) */ },
  };
}
```

The `SandboxLike` type is the minimal public interface an extension depends on:

```typescript
type SandboxLike = {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  containerFetch(request: Request, port?: number): Promise<Response>;
  fetch(request: Request): Promise<Response>;
  createSession(options?: SessionOptions): Promise<ExecutionSession>;
};
```

This is satisfied by both the DO stub (Worker context) and the `Sandbox` instance (`this` in a subclass).

### Caveats

- **`containerFetch` must be a stable public API.** It's on the `Sandbox` class today but may not be formally part of the stub interface returned by `getSandbox()`. We need to audit this and ensure it works reliably on both the stub and instance. This is the key primitive that interpreter and terminal extensions need.
- **Instance fields in subclasses run at construction time.** `git = withGit(this)` executes during the constructor, before `blockConcurrencyWhile` finishes. The extension must be lazy enough to handle this — it shouldn't make requests at construction time, only when a method is called. This is already the natural shape (factory returns an object with async methods).
- **No RPC pipelining.** Extensions use `containerFetch`/`exec` (flat RPC methods), not property getter pipelining. This avoids the known vite-plugin issue that affects `tunnels` today.

**Pros:**
- **One pattern, both contexts.** Same `withGit(sandbox)` call works on stub and instance.
- **No stub mutation.** Returns a new object every time.
- **No internal coupling.** Depends only on `SandboxLike` — a small, stable public surface.
- **Namespaced.** `git.checkout(...)` / `interpreter.runCode(...)`.
- **No class hierarchy changes.** No mixins, no TypeScript generic gymnastics.
- **Testable.** Mock the `SandboxLike` interface in unit tests.
- **Real slimming.** `GitClient`, `InterpreterClient`, `CodeInterpreter`, `proxyTerminal` all move out of core.

**Cons:**
- Extensions don't appear on the typed stub automatically. Callers must call `withGit(sandbox)` explicitly. Subclasses must assign to a field.
- Requires `containerFetch` to be promoted to a stable public API on the stub.

---

## 5. What Gets Extracted

The extraction goes deep — not just the API methods, but the **clients, types, and orchestration code** that back them. The core SDK should not import any of these.

### SDK side (`@cloudflare/sandbox` → plugin modules)

| What moves | From | To |
|---|---|---|
| `GitClient` class (105 lines) | `clients/git-client.ts` | `@cloudflare/sandbox/git` |
| `InterpreterClient` class (344 lines) | `clients/interpreter-client.ts` | `@cloudflare/sandbox/interpreter` |
| `CodeInterpreter` class (146 lines) | `interpreter.ts` | `@cloudflare/sandbox/interpreter` |
| `proxyTerminal` utility (30 lines) | `pty/proxy.ts` | `@cloudflare/sandbox/terminal` |
| `gitCheckout()` + session wiring | `sandbox.ts`, `getSandbox()`, `getSessionWrapper()` | `@cloudflare/sandbox/git` |
| 5 interpreter methods + `codeInterpreter` field | `sandbox.ts`, `getSandbox()`, `getSessionWrapper()` | `@cloudflare/sandbox/interpreter` |
| `terminal` enhanced method | `getSandbox()`, `enhanceSession()` | `@cloudflare/sandbox/terminal` |

**`SandboxClient` changes:** Remove `GitClient` and `InterpreterClient` from the constructor. Remove `git` and `interpreter` fields. The core client only instantiates: `CommandClient`, `FileClient`, `ProcessClient`, `PortClient`, `BackupClient`, `UtilityClient`, `WatchClient`.

**`ContainerControlClient` changes:** Remove `git` and `interpreter` from the `SandboxAPI` type constraint (or make them optional). The RPC stub's lazy getters for `git`/`interpreter` are still available on the wire — plugins access them via the raw stub.

### Container side

**Git — container service can be removed.** `GitService` (514 lines), `GitManager` (264), `GitHandler` (69), `GitRPCAPI` (~33) all exist to wrap `git clone` with validation and error handling. The `withGit` extension can do this via `sandbox.exec('git clone ...')` instead. No dedicated container endpoint needed — ~880 lines removed from the container.

**Interpreter & Terminal — container services stay.** `InterpreterService` manages persistent IPython/Node REPL contexts (stateful, can't be replicated with `exec`). `PtyWebSocketHandler` handles WebSocket-to-PTY upgrades (the shell runs in the container). These endpoints remain; extensions call them via `containerFetch`/`fetch`.

### Shared types (`@repo/shared`)

Types like `GitCheckoutResult`, `SandboxGitAPI`, `SandboxInterpreterAPI` can stay in `@repo/shared` since they're used by both the container-side services and the plugin modules. They're compile-time types with no runtime cost. Alternatively, they could move to the plugin modules and be re-exported from shared — this is a packaging detail, not an architectural one.

### What stays in core

Exec, file ops, sessions, processes, env vars, lifecycle, ports, backup, tunnels, bucket mounting.

> **Future work.** Tunnels, backup, and bucket mounting can be extracted later. Those need lifecycle hooks (`onStart`/`onStop`/`destroy`), DO storage, and egress handler registration — a simple factory function may not be sufficient. Those extractions may require class mixins or `protected` APIs on `Sandbox`. That's out of scope for this proposal.

---

## 6. Sessions

Today `ExecutionSession` duplicates the entire `Sandbox` API with a bound `sessionId`. In the new design, **sessions are slim core objects**:

```typescript
const sandbox = getSandbox(env.MySandbox, 'my-sandbox');
const git = withGit(sandbox);
const session = await sandbox.createSession({ id: 'work' });

await session.exec('ls');                    // core — on session
await session.writeFile('/tmp/x', 'data');   // core — on session
await git.checkout(repo, { sessionId: session.id }); // extension — accepts sessionId
```

- **Core methods** live on `ExecutionSession` — used constantly, benefit from bound context.
- **Extension methods** live on the namespace object — accept an optional `sessionId` when session-scoping is needed.

Extensions never touch the session wrapper. No combinatorial explosion.

---

## 7. Package Structure

Subpath exports within the single `@cloudflare/sandbox` package:

```
@cloudflare/sandbox             → slim core (Sandbox, getSandbox, SandboxLike, exec, files, sessions, etc.)
@cloudflare/sandbox/git         → withGit + Git interface
@cloudflare/sandbox/interpreter → withInterpreter + Interpreter interface
@cloudflare/sandbox/terminal    → withTerminal + Terminal interface
```

Single package, single version. Each extension module exports one factory function and one interface type.

**There is no plugin framework.** The `SandboxLike` type exported from `@cloudflare/sandbox` is the entire contract. A third-party extension is just a function that accepts `SandboxLike` and returns an object:

```typescript
import type { SandboxLike } from '@cloudflare/sandbox';

export function withMyTool(sandbox: SandboxLike): MyTool {
  return {
    async doSomething() {
      return sandbox.exec('my-tool --run');
    },
  };
}
```

No registration, no base class, no lifecycle hooks. Plain TypeScript.

---

## 8. Implementation Plan

Ships as a single major version.

1. **Stabilize `containerFetch`** — Audit and ensure `containerFetch()` is a stable public method on both the `Sandbox` class and the stub returned by `getSandbox()`. This is the key primitive extensions need.
2. **Create extension modules** — Create `@cloudflare/sandbox/git`, `/interpreter`, `/terminal`. Each exports a `with*` factory and a capability interface. Implementations use `containerFetch`/`exec`/`fetch` only.
3. **Slim core** — Remove `GitClient`, `InterpreterClient`, `CodeInterpreter`, `proxyTerminal` from core imports. Remove `git` and `interpreter` fields from `SandboxClient`. Remove extracted methods from `Sandbox`, `ISandbox`, `ExecutionSession`, `getSandbox()` proxy.
4. **Update examples & tests** — All examples adopt `const git = withGit(sandbox)` pattern.
5. **Migration guide:**

| Before | After |
|---|---|
| `sandbox.gitCheckout(url)` | `withGit(sandbox).checkout(url)` |
| `sandbox.runCode(code)` | `withInterpreter(sandbox).runCode(code)` |
| `sandbox.terminal(req)` | `withTerminal(sandbox).connect(req)` |

---

## 9. Open Questions

1. **`containerFetch` on the stub.** Need to verify `containerFetch()` is callable on the RPC stub returned by `getSandbox()`, not just on the `Sandbox` class instance. If not, we need to wire it through the `getSandbox()` proxy or find an alternative primitive.

2. **Container-side errors.** If an extension calls a container service that isn't installed (e.g., interpreter on a minimal image), should it fail at call time with a clear error? Recommendation: yes — fail at call time with a descriptive message.

---

## 10. Summary

| Aspect                | Decision                                                           |
| -----------------------| --------------------------------------------------------------------|
| **Pattern**           | Factory function: `const git = withGit(sandbox)`                   |
| **Works on**          | Both the DO stub (Worker context) and `this` (subclass context)    |
| **Depends on**        | `SandboxLike` — `exec`, `containerFetch`, `fetch`, `createSession` |
| **Internal coupling** | None. Extensions use public API only.                              |
| **Stub mutation**     | None. Returns a new namespaced object.                             |
| **Package structure** | Subpath exports: `@cloudflare/sandbox/git`                         |
| **Core surface**      | exec, files, sessions, processes, env, lifecycle, ports            |
| **Sessions**          | Slim core objects. Extensions accept `sessionId` param.            |

One pattern, one function, both contexts. `withGit(sandbox)` returns a `Git` namespace object whether `sandbox` is a stub or `this`. No mixins, no dispatch methods, no class hierarchy changes. Unused extensions don't enter the Worker bundle.
