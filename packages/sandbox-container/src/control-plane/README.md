# Control plane

This directory owns the container-side control API called by the Sandbox Durable
Object.

The current implementation is exposed through capnweb over the `/rpc` WebSocket
route, but the architectural boundary is the container control plane, not the
transport mechanism.

Container control operations are implemented here and call the underlying
services directly. The shared `@repo/shared` `SandboxAPI` interface defines the
control API contract used by both sides.
