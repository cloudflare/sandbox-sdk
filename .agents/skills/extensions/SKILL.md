---
name: extensions
description: Use when authoring or reviewing a Cloudflare Sandbox SDK extension — an opt-in capability attached to a Sandbox subclass via `withX(this)` and shipped as a `@cloudflare/sandbox/<name>` subpath. Covers the single `SandboxExtension` base class, the SDK-only vs container-sidecar split (driven by an optional npm-tarball `ExtensionPackage`), the capnweb sidecar host internals, RPC-safety rules, calling extensions from a Worker, streaming via typed callbacks, subpath wiring, and testing. Load it for tasks like "extract X into `withX()`", "add a sidecar extension", or reviewing extension code. (project)
---

# Sandbox SDK Extensions

An **extension** adds a capability to a user's `Sandbox` subclass. It is opt-in,
attached as a class field via a `withX(this)` factory, and talks to the
container over the **capnweb RPC control channel** — never an exposed port,
never HTTP.

There is exactly **one** way to build one: subclass **`SandboxExtension`** from
`@cloudflare/sandbox/extensions`. Do not hand-roll `RpcTarget` classes, do not
invent new patterns. Two flavors share that single base:

- **SDK-only** — orchestrates existing container control sub-APIs
  (`commands`, `files`, `git`, `processes`, `interpreter`, …). No sidecar.
- **Sidecar** — ships an npm-style tarball that the container provisions and
  spawns. The sidecar speaks capnweb back over a unix socket; the SDK
  obtains a typed remote stub via `this.sidecar<T>()`.

The flavor is decided by **whether you pass an `ExtensionPackage`** —
nothing else.

> **Status (this branch):** the framework itself (`@cloudflare/sandbox/extensions`
>
> - `@cloudflare/sandbox/sidecar`) is implemented and tested, but **no concrete
>   sidecar extension ships here yet**. The `Interpreter` / `withInterpreter`
>   snippets below are **illustrative** — the interpreter extraction lives on a
>   separate branch and is not present on `feat/extension-framework`. Likewise,
>   npm distribution of third-party extensions is not wired up: today the only
>   producer of tarball bytes is the in-repo build pipeline. The wire shape,
>   capnweb sidecar contract, and host/SDK API are the same ones a future public
>   authoring story will use — what's deferred is concrete extensions and
>   publishing/install tooling, not the architecture.

## The golden path

Always follow this shape: a class extending `SandboxExtension` and a
`withX(sandbox)` factory. Worker code can call the extension directly as a
nested namespace (`sandbox.<field>.<method>(...)`); a delegate method on the
Sandbox subclass is now optional, not required.

```typescript
import {
  SandboxExtension,
  type SandboxLike
} from '@cloudflare/sandbox/extensions';
import { shellEscape } from '@repo/shared';

// SDK-only extension: drives existing sub-APIs, no package.
class ClaudeCode extends SandboxExtension {
  constructor(sandbox: SandboxLike) {
    super(sandbox);
  }

  async ask(prompt: string, sessionId: string): Promise<string> {
    const { stdout } = await this.client.commands.execute(
      `claude -p ${shellEscape(prompt)}`,
      sessionId
    );
    return stdout;
  }
}
export const withClaudeCode = (s: SandboxLike) => new ClaudeCode(s);
```

```typescript
// Sidecar extension: ship a tarball and get a typed capnweb remote main.
import sidecarTarballBytes from './sidecar-package.tgz';
import type { InterpreterSidecarAPI } from './shared';

class Interpreter extends SandboxExtension {
  constructor(sandbox: SandboxLike) {
    super(sandbox, { tarball: new Uint8Array(sidecarTarballBytes) });
  }

  async runCode(
    code: string,
    onProgress?: (event: { kind: string; data: unknown }) => void
  ) {
    const api = await this.sidecar<InterpreterSidecarAPI>();
    return api.runCode(code, onProgress ?? (() => {}));
  }
}
export const withInterpreter = (s: SandboxLike) => new Interpreter(s);
```

Wire it onto a Sandbox subclass. Worker code calls it directly (see _Calling
from a Worker_):

```typescript
export class Sandbox extends BaseSandbox<Env> {
  claudeCode = withClaudeCode(this);
}

// Worker: sandbox.claudeCode.ask(...) works directly.
// A delegate (sandbox.ask(...)) is optional if you want a flatter API.
```

## Rules (do not deviate)

1. **Extend `SandboxExtension`.** It is an `RpcTarget`, captures the sandbox
   in a `#private` field, and exposes `protected get client(): SandboxAPI`.
   Never re-implement this; never extend `RpcTarget` directly for an extension.
2. **Import `SandboxLike` from `@cloudflare/sandbox/extensions`.** Do not
   redefine it. It is `{ readonly client: SandboxAPI }` — the framework's
   contract.
3. **Declare a constructor + `withX(sandbox)` factory.** The base constructor
   is `protected`, so each extension needs its own (`constructor(s) { super(s) }`
   or `super(s, { tarball })`). The factory is the public API.
4. **Stay lazy.** The constructor must not fire any RPC. Only capture the
   sandbox (the base already does this) and reach `this.client.*` _inside_
   methods. Field initializers (`x = withX(this)`) run after `super()`, so
   `this.client` exists — but an eager RPC in a constructor fires during DO
   construction and is fragile.
5. **Sidecar features need a package.** `sidecar()` / `sidecarHealth()` /
   `stopSidecar()` throw if no `ExtensionPackage` was passed. Pass one to
   `super()` to use them.
6. **No `any`; no exposed ports/preview URLs.** Put shared wire types in
   `@repo/shared` (or in the extension's own `./shared` module). Extensions
   are RPC-only.

## What the base gives you

- `protected get client(): SandboxAPI` — the container control client. Use
  `this.client.commands`, `this.client.files`, etc.
- `protected sidecar<T extends object>(): Promise<T>` — provision + spawn
  the sidecar on demand and return its typed capnweb remote main. `T` is
  the sidecar's `SandboxSidecar` subclass shape. Each call reconnects
  through the host so a crashed sidecar can be restarted on the next use.
- `protected sidecarHealth()` / `protected stopSidecar()` — sidecar
  lifecycle.

**Streaming is just a typed callback parameter** on a sidecar method.
capnweb stubs the callback and routes invocations back through both the
SDK → container and container → sidecar hops; no separate `call()` /
`callStream()` distinction, no `onEvent` plumbing.

## Building a sidecar extension

A sidecar is a self-contained npm package the container provisions and
supervises. You provide an **`ExtensionPackage`** (just the tarball bytes
the build pipeline produces) and a **sidecar program**.

### Tarball shape

The tarball is an npm-style `.tgz` whose `package.json` declares:

```jsonc
{
  "name": "demo-sidecar", // becomes the slugified id
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "demo-sidecar": "./dist/sidecar.js"
  },
  "sandboxExtension": {
    "bin": "demo-sidecar", // disambiguates when there are multiple bins
    "readinessTimeoutMs": 5000
  }
}
```

Identity is **content-hash-keyed**: any byte change reprovisions, even at
the same package version. The host extracts `package.json`, derives the
extension id by slugifying `name` (`@acme/foo` → `acme-foo`), and resolves
the bin via `sandboxExtension.bin` or the single `bin` entry.

The sidecar entry should be **pre-bundled** (esbuild / `Bun.build`) so
`bun add ./extension.tgz` resolves no transitive deps and runs offline.

### Sidecar program contract

```typescript
import {
  SandboxSidecar,
  serveSandboxSidecar
} from '@cloudflare/sandbox/sidecar';

class InterpreterApi extends SandboxSidecar {
  async runCode(
    code: string,
    onEvent: (event: { kind: string; data: unknown }) => void | Promise<void>
  ): Promise<{ ok: true }> {
    await onEvent({ kind: 'stdout', data: 'starting\n' });
    // ...
    return { ok: true };
  }
}

serveSandboxSidecar(new InterpreterApi());
```

The `SandboxSidecar` base implements `__ping__` (reserved for health
probes — do not override). `serveSandboxSidecar` reads `EXT_SOCKET` from
env (injected by the container's `ExtensionHost`), opens the unix socket,
and serves one capnweb session per connection with `target` as the local
main.

## Calling an extension from a Worker

Extension methods are directly callable as `sandbox.<field>.<method>(...)`
from a Worker. `getSandbox()` returns a Proxy: when you access an unknown
property it hands back a callable/nested proxy, and a nested call routes
through `stub.callExtension(<field>, <method>, args)`, a top-level DO
dispatch method. This sidesteps capnweb property-pipelining limits while
preserving the nice nested API.

```typescript
export class Sandbox extends BaseSandbox<Env> {
  claudeCode = withClaudeCode(this);
}

// Worker: both forms work.
await sandbox.claudeCode.ask(prompt, sessionId); // direct nested call
```

`Sandbox.callExtension(name, method, args)` resolves the field on the DO,
verifies it is a real `SandboxExtension`, and only dispatches methods
defined on the concrete extension class — inherited base methods like
`sidecar()` are **not** callable from a Worker. Adding a delegate method
(`sandbox.ask(...)`) is still fine if you want a flatter surface, but it is
optional. **Inside** the DO (`this.claudeCode.ask()`) it is always a plain
local call.

### Return values must be RPC-safe

Extension methods run inside the DO, so their return values cross the
Worker/DO boundary and get serialized. Return structured-clone-friendly
data (plain objects, arrays, primitives, `ReadableStream`), **not** class
instances — returning a class instance throws `DataCloneError` at runtime.
This is why the interpreter's `runCode()` returns a plain `ExecutionResult`
(via `Execution.toJSON()`) rather than the `Execution` instance it builds
internally. If you genuinely need live methods on the returned object, the
`RpcTarget` escape hatch keeps them callable as remote stubs at the cost of
an extra round-trip per call and stub lifecycle management; prefer plain
data for one-shot results.

## Streaming

- Pass a callback parameter to a sidecar method. capnweb stubs the
  callback and routes invocations back through both hops. The sidecar
  awaits the callback exactly the same way it would locally.
- There is **no** `onEvent` framework option, no string event kinds, no
  retry plumbing. The shared TypeScript interface is the contract.
- Returning a stream across the DO→Worker boundary still must use a
  `ReadableStream` (transferable). Prefer accumulating server-side and
  returning a plain, cloneable result where possible (see _Return values
  must be RPC-safe_).

## Wire protocol (hash-first connect)

The SDK hashes the tarball locally and first sends only the hash on
`client.extensions.connect()`. If the current host process has not yet
provisioned that hash, it throws `ExtensionTarballRequiredError` (wire
name `EXTENSION_TARBALL_REQUIRED`); the SDK retries once with `tarball`
attached.

`ExtensionHost` provisions by content hash:

1. write `extension.tgz` under `/var/lib/sandbox-extensions/<hash>/`,
2. read `package/package.json` from the tarball (in-process),
3. derive the registration (slug id, version, bin, readiness timeout),
4. `bun add --ignore-scripts ./extension.tgz` (no scripts unless the
   `ExtensionPackage` sets `allowInstallScripts: true`),
5. `Bun.spawn` the resolved bin under `bun`, inject `EXT_SOCKET` /
   `EXT_DIR`, wait for the capnweb connection.

Provisioning is **idempotent** inside a host process: re-connecting with
same hash is a no-op after the package is registered. A crashed sidecar is
restarted transparently on the next `sidecar()` call.

## Instance lifecycle

- One extension instance per DO cold start, shared across every
  `getSandbox()` stub for that DO. Fine for caching, but treat any local
  cache as best-effort — the container is the source of truth and can
  restart. Re-sync via a list/refresh call when needed.
- The field name (`claudeCode`, `interpreter`) must not collide with a
  base `Sandbox` member.

## Authoring checklist ("extract X into `withX()`")

1. **Module** `packages/sandbox/src/<name>/index.ts`: a class extending
   `SandboxExtension`, the `withX(sandbox)` factory, and (for sidecars)
   the sidecar program source and a build step that emits its tarball.
2. **Subpath export**: add `./<name>` to `packages/sandbox/package.json`
   `exports` and an entry to `packages/sandbox/tsdown.config.ts`.
3. **Shared types**: any new wire types go in `@repo/shared`
   (`rpc-types.ts`) or in the extension's own typed-interface module
   compiled into both ends. Rebuild with `npm run build -w @repo/shared`
   before typechecking dependents.
4. **Worker exposure**: direct nested calls (`sandbox.<field>.<method>`)
   work via `callExtension` dispatch; ensure methods return RPC-safe data,
   not class instances. Delegate methods on the subclass are optional.
5. **Unit test** `packages/sandbox/tests/<name>.test.ts`: mock
   `sandbox.client.<subApi>` (or `client.extensions` for sidecars);
   assert lazy construction (no RPC in constructor), input validation,
   happy path, and (for sidecars) the hash-first connect retry. Mirror
   `packages/sandbox/tests/extensions.test.ts`.
6. **Sidecar host test** (if applicable): exercise the real spawned
   sidecar against a fixture tarball in
   `packages/sandbox-container/tests/extensions/`. Mirror
   `extension-host.test.ts`. Run via an explicit file path — `bun test
tests/extensions` resolves the `@cloudflare/sandbox` workspace
   symlink and tries to run SDK vitest files under Bun (which lacks
   `cloudflare:workers`).
7. **Changeset**: `patch` unless the public surface changes;
   `@cloudflare/sandbox` only; user-facing description (see the
   changesets skill).
8. `npm run check` + `npm test -w @cloudflare/sandbox`.

## Architecture (for reviewers)

SDK side — `packages/sandbox/src/extensions/index.ts`:

- `SandboxExtension` — the single base class. Handles hash-first connect
  with one bytes-attached retry and reconnects through the host on each
  `sidecar()` call to avoid stale stubs after crashes.
- `ContainerControlClient.get extensions()`
  (`container-control/client.ts`) surfaces the capnweb `extensions`
  sub-API (`connect` / `health` / `stop`).

Sidecar helper — `packages/sandbox/src/sidecar/index.ts`:

- `SandboxSidecar` — `RpcTarget` base with the reserved `__ping__`.
- `serveSandboxSidecar(target)` — opens the `EXT_SOCKET` unix socket,
  serves a capnweb session per connection.
- `SocketTransport` — length-prefixed capnweb transport over a Node
  socket; mirrors the host-side transport.

Shared — `packages/shared/src/rpc-types.ts`: `ExtensionPackage`,
`ExtensionRegistration`, `ExtensionConnectRequest`, `ExtensionHealth`,
`EXTENSION_TARBALL_REQUIRED`, and `SandboxExtensionsAPI` (a member of
`SandboxAPI`).

Container side — `packages/sandbox-container/src/extensions/`:

- `extension-host.ts` — `ExtensionHost`: provision-by-content-hash, lazy
  spawn via `Bun.spawn`, supervise (transparent restart), connect
  capnweb bridge, return remote main stubs.
- `provision.ts` — in-process tar reader, package.json derivation,
  `bun add --ignore-scripts ./extension.tgz`.
- `capnweb-bridge.ts` + `socket-transport.ts` — capnweb session over a
  unix socket; `remoteMain()` returns a `.dup()`-ed stub so callers can
  dispose freely without tearing down the underlying session.
- `control-plane/api.ts` `ExtensionsRPCAPI` — the `client.extensions`
  surface.

Design rationale: `docs/EXTENSION_ARCHITECTURE_V2.md` (context only).

## Key files

- `packages/sandbox/src/extensions/index.ts` — `SandboxExtension`.
- `packages/sandbox/src/sidecar/index.ts` — sidecar author helper.
- `packages/sandbox/tests/extensions.test.ts` — reference SDK unit tests.
- `packages/sandbox/src/sandbox.ts` — `getSandbox()` Proxy (nested-call
  trap) + `Sandbox.callExtension()` dispatch (concrete-method-only).
- `packages/sandbox/src/tunnels/tunnels-handler.ts` — `RpcTarget` +
  `callTunnels` dispatch precedent.
- `packages/sandbox/package.json` (`exports`) + `tsdown.config.ts` —
  subpath wiring (`./extensions`, `./sidecar`).
- `packages/sandbox-container/src/extensions/` — `ExtensionHost`,
  capnweb bridge, provisioning.
- `packages/sandbox-container/tests/extensions/extension-host.test.ts` —
  end-to-end fixture-tarball validation.
