---
name: extensions
description: Use when authoring or reviewing a Cloudflare Sandbox SDK extension — an opt-in capability attached to a Sandbox subclass via `withX(this)` and shipped as a `@cloudflare/sandbox/<name>` subpath. Covers the single `SandboxExtension` base class, the SDK-only vs container-sidecar split (driven by an optional manifest), the sidecar bridge/host internals, RPC-safety rules, calling extensions from a Worker, streaming, subpath wiring, and testing. Load it for tasks like "extract X into `withX()`", "add a sidecar extension", or reviewing extension code. (project)
---

# Sandbox SDK Extensions

An **extension** adds a capability to a user's `Sandbox` subclass. It is opt-in,
attached as a class field via a `withX(this)` factory, and talks to the container
over the **capnweb RPC control channel** — never an exposed port, never HTTP.

There is exactly **one** way to build one: subclass **`SandboxExtension`** from
`@cloudflare/sandbox/extensions`. Do not hand-roll `RpcTarget` classes, do not
invent new patterns. Two flavors share that single base:

- **SDK-only** — orchestrates existing container control sub-APIs (`commands`,
  `files`, `git`, `processes`, `interpreter`, …). No manifest.
- **Sidecar** — ships a process that runs inside the container and speaks a
  structured protocol the control sub-APIs can't express. Opt in by passing an
  `ExtensionManifest` to `super()`.

The flavor is decided by **whether you pass a manifest** — nothing else.

## The golden path

Always follow this shape: a class extending `SandboxExtension`, a `withX(sandbox)`
factory, and (to call from a Worker) a delegate method on the Sandbox subclass.

```typescript
import {
  SandboxExtension,
  type SandboxLike
} from '@cloudflare/sandbox/extensions';
import { shellEscape } from '@repo/shared';

// SDK-only extension: drives existing sub-APIs, no manifest.
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
// Sidecar extension: opt in with a manifest, then use the protected
// call / health / stop helpers. Stream by passing { onEvent }.
class Interpreter extends SandboxExtension {
  constructor(sandbox: SandboxLike) {
    super(sandbox, buildInterpreterManifest());
  }
  runCode(code: string) {
    return this.call('runCode', [code]);
  }
  runCodeStream(code: string, onEvent: ExtensionEventHandler) {
    return this.call('runCode', [code], { onEvent });
  }
}
export const withInterpreter = (s: SandboxLike) => new Interpreter(s);
```

Wire it onto a Sandbox subclass and expose a delegate (see _Calling from a
Worker_):

```typescript
export class Sandbox extends BaseSandbox<Env> {
  claudeCode = withClaudeCode(this);
  ask(prompt: string, sessionId: string) {
    return this.claudeCode.ask(prompt, sessionId);
  }
}
```

## Rules (do not deviate)

1. **Extend `SandboxExtension`.** It is an `RpcTarget`, captures the sandbox in a
   `#private` field, and exposes `protected get client(): SandboxAPI`. Never
   re-implement this; never extend `RpcTarget` directly for an extension.
2. **Import `SandboxLike` from `@cloudflare/sandbox/extensions`.** Do not redefine
   it. It is `{ readonly client: SandboxAPI }` — the framework's contract.
3. **Declare a constructor + `withX(sandbox)` factory.** The base constructor is
   `protected`, so each extension needs its own (`constructor(s) { super(s) }` or
   `super(s, buildManifest())`). The factory is the public API.
4. **Stay lazy.** The constructor must not fire any RPC. Only capture the sandbox
   (the base already does this) and reach `this.client.*` _inside_ methods.
   Field initializers (`x = withX(this)`) run after `super()`, so `this.client`
   exists — but an eager RPC in a constructor fires during DO construction and is
   fragile.
5. **Sidecar features need a manifest.** `call` / `health` / `stop` /
   `extensionId` throw if no manifest was passed. Pass one to `super()` to use
   them.
6. **No `any`; no exposed ports/preview URLs.** Put shared wire types in
   `@repo/shared`. Extensions are RPC-only.

## What the base gives you

- `protected get client(): SandboxAPI` — the container control client. Use
  `this.client.commands`, `this.client.files`, etc.
- `protected call(method, args?, options?)` — invoke a sidecar method (registers
  - starts the sidecar on first use). Pass `{ onEvent }` in `options` to stream
    events; omit it for a buffered call.
- `protected health()` / `protected stop()` — sidecar lifecycle.
- `protected get extensionId` — the manifest id.

There is **one** `call` method — streaming is just `call(method, args, { onEvent })`.
Registration is automatic, **once, lazily**, on first sidecar call (retried on
failure). Readiness retry and stream-event de-duplication are handled for you —
do not add your own retry around `call`.

## Building a sidecar extension

A sidecar is a process the container provisions and supervises. You provide a
**manifest** and a **sidecar program**.

**Manifest** (`ExtensionManifest` from `@cloudflare/sandbox/extensions`):

```typescript
import type { ExtensionManifest } from '@cloudflare/sandbox/extensions';

function buildInterpreterManifest(): ExtensionManifest {
  return {
    id: 'interpreter',
    version: '1', // id+version = identity; bump to reprovision
    assets: [
      // written to disk on first use
      { path: 'server.cjs', content: SERVER_SOURCE } // or { ..., encoding: 'base64', mode: 0o755 }
    ],
    command: ['bun', '{dir}/server.cjs'], // {dir} = provisioned dir, {socket} = bridge socket
    readinessTimeoutMs: 10_000
  };
}
```

Ship the sidecar runtime as `assets[]` so it stays **out of the compiled
container binary** — this is how a feature is fully extracted from core. Use
`encoding: 'base64'` + `mode: 0o755` for prebuilt binaries; match arch/libc
(glibc vs musl) for native code.

**Sidecar program contract** (mirror `packages/sandbox-container/src/extensions/echo-sidecar.ts`):
a self-contained process — no imports from the host — that:

- listens on the unix socket at `process.env.EXT_SOCKET`,
- speaks the frame protocol: 4-byte big-endian length + UTF-8 JSON, message
  kinds `req` (in), `res` (ok/err, out), `evt` (streaming, out, correlated to the
  request `id`),
- implements `__ping__` → returns `"pong"` (reserved for health probes),
- stays portable (runs under Bun or Node).

Keep the sidecar source inline (a string asset) for portability, or ship a
binary. The container `ExtensionHost` spawns it lazily on first call, supervises
it (transparent re-provision + restart after a crash or container sleep/wake),
and bridges calls over the socket. Unused extensions cost ~nothing.

## Calling an extension from a Worker

Extension methods are not directly callable as `sandbox.myExt.method()` from a
Worker: property pipelining through the DO stub is **broken under the current
vite-plugin runtime** (see `TunnelsRpcTarget` in
`packages/sandbox/src/tunnels/tunnels-handler.ts`). `SandboxExtension` keeps the
`RpcTarget` shape ready for when that lifts, but **do not rely on it today**.

Expose extension behavior to the Worker with a **delegate method** on the Sandbox
subclass. `getSandbox()` returns a Proxy that forwards any non-enhanced public DO
method to the stub, so a thin method is automatically callable:

```typescript
export class Sandbox extends BaseSandbox<Env> {
  claudeCode = withClaudeCode(this);
  // sandbox.claudeCode.ask(...) → NO. sandbox.ask(...) → YES.
  ask(prompt: string, sessionId: string) {
    return this.claudeCode.ask(prompt, sessionId);
  }
}
```

For a full `sandbox.myExt.*` surface, mirror the `callTunnels` dispatch + Proxy
pattern in `packages/sandbox/src/sandbox.ts`. **Inside** the DO
(`this.claudeCode.ask()`) it is a plain local call — the caveat only concerns the
DO→Worker hop.

## Streaming

- Stream via `call(method, args, { onEvent })`. The framework forwards `evt`
  frames to `onEvent` and guarantees no duplicate events on a readiness retry —
  you do not manage retries.
- If you build your own retry that accumulates streamed output, construct the
  accumulator **inside** the retry lambda so a partial-then-failed attempt does
  not leave stale entries.
- Returning a stream across the DO→Worker boundary must use a `ReadableStream`
  (transferable). Prefer accumulating server-side and returning a plain result
  where possible.

## Instance lifecycle

- One extension instance per DO cold start, shared across every `getSandbox()`
  stub for that DO. Fine for caching, but treat any local cache as best-effort —
  the container is the source of truth and can restart. Re-sync via a list/
  refresh call when needed.
- The field name (`claudeCode`, `interpreter`) must not collide with a base
  `Sandbox` member.

## Authoring checklist ("extract X into `withX()`")

1. **Module** `packages/sandbox/src/<name>/index.ts`: a class extending
   `SandboxExtension`, the `withX(sandbox)` factory, and (for sidecars) a
   `build<Name>Manifest()` + the sidecar program/asset.
2. **Subpath export**: add `./<name>` to `packages/sandbox/package.json`
   `exports` and an entry to `packages/sandbox/tsdown.config.ts`.
3. **Shared types**: any new wire types go in `@repo/shared` (`rpc-types.ts`).
   Rebuild with `npm run build -w @repo/shared` before typechecking dependents.
4. **Worker exposure**: add delegate method(s) on the consumer Sandbox subclass
   (never direct field pipelining).
5. **Unit test** `packages/sandbox/tests/<name>.test.ts`: mock
   `sandbox.client.<subApi>` (or `client.extensions` for sidecars); assert lazy
   construction (no RPC in constructor), input validation, happy path, and (for
   sidecars) register-once + id-binding. Mirror
   `packages/sandbox/tests/extensions.test.ts`.
6. **Sidecar host test** (if applicable): exercise the real spawned sidecar in
   `packages/sandbox-container/tests/extensions/`. Mirror `extension-host.test.ts`.
   Run it via an explicit file path — `bun test tests/extensions` resolves the
   `@cloudflare/sandbox` workspace symlink and tries to run SDK vitest files
   under Bun (which lacks `cloudflare:workers`).
7. **Changeset**: `patch` unless the public surface changes; `@cloudflare/sandbox`
   only; user-facing description (see the changesets skill).
8. `npm run check` + `npm test -w @cloudflare/sandbox`.

## Architecture (for reviewers)

SDK side — `packages/sandbox/src/extensions/index.ts`:

- `SandboxExtension` — the single base class (above).
- `Extensions` / `withExtensions(sandbox)` — low-level client wrapping
  `sandbox.client.extensions` (`register` / `call` / `health` / `stop`; `call`
  takes `{ onEvent }` to stream) with bounded readiness retry + stream de-dup.
  The base uses this internally; it is also an escape hatch for ad-hoc use.
  (The capnweb wire keeps separate `call` / `callStream` methods underneath.)
- `ContainerControlClient.get extensions()` (`container-control/client.ts`)
  surfaces the capnweb `extensions` sub-API.

Shared — `packages/shared/src/rpc-types.ts`: `ExtensionManifest`,
`ExtensionAsset`, `ExtensionHealth`, and `SandboxExtensionsAPI` (a member of
`SandboxAPI`).

Container side — `packages/sandbox-container/src/extensions/`:

- `extension-host.ts` — `ExtensionHost`: provision assets (idempotent, keyed by
  id+version), lazy spawn, supervise (transparent restart), `call` over the
  bridge, bounded `__ping__` health. Wired into `core/container.ts` DI and
  cleaned up in `server.ts`.
- `bridge.ts` + `protocol.ts` — unix-socket client + frame codec.
- `echo-sidecar.ts` — reference sidecar.
- `control-plane/api.ts` `ExtensionsRPCAPI` — the `client.extensions` surface.

Design rationale and the provisioning option ladder: `docs/EXTENSION_ARCHITECTURE_V2.md`
(context only).

## Key files

- `packages/sandbox/src/extensions/index.ts` — `SandboxExtension`, `withExtensions`.
- `packages/sandbox/tests/extensions.test.ts` — reference SDK unit tests.
- `packages/sandbox/src/tunnels/tunnels-handler.ts` — `RpcTarget` + `callTunnels`
  dispatch precedent and the Worker-pipelining caveat.
- `packages/sandbox/src/sandbox.ts` — `getSandbox()` Proxy + `callTunnels`.
- `packages/sandbox/package.json` (`exports`) + `tsdown.config.ts` — subpath wiring.
- `packages/sandbox-container/src/extensions/` — `ExtensionHost`, bridge, protocol,
  echo sidecar.
- `packages/sandbox-container/tests/extensions/extension-host.test.ts` —
  end-to-end sidecar validation.
