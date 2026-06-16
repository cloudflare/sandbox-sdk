# Control plane

This directory owns the container-side control API called by the Sandbox Durable
Object.

The architectural boundary is the container control plane itself; capnweb over
the `/rpc` WebSocket is the wire implementation.

Container control operations are implemented here and call the underlying
services directly. The shared `@repo/shared` `SandboxAPI` interface defines the
control API contract used by both sides.
