---
'@cloudflare/sandbox': patch
---

Add the experimental `@cloudflare/sandbox/extensions` framework for attaching opt-in SDK extensions and lazily started container sidecars to a Sandbox subclass. Sidecars are distributed as npm-style `.tgz` packages: the SDK ships the bytes, the container provisions by content hash, derives identity from the embedded `package.json`, and `bun add`s the package. Host ↔ sidecar IPC runs over capnweb on a unix socket, so sidecar methods are a typed remote stub via `await this.sidecar<T>()` — streaming is just a typed callback parameter. Sidecar authors get a `@cloudflare/sandbox/sidecar` helper (`SandboxSidecar` + `serveSandboxSidecar`). npm distribution of third-party extensions is not yet wired up; the wire shape is the one a future authoring story will use.
