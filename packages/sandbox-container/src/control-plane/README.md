# Control plane

This directory owns the container-side control API called by the Sandbox Durable
Object.

The current implementation is exposed through capnweb over the `/rpc` WebSocket
route, but the architectural boundary is the container control plane, not the
transport mechanism.

Container control operations are implemented here and call the underlying
services directly. The legacy route-based HTTP/WebSocket control API has been
removed; do not route SDK control operations through handlers or routes.

The shared `@repo/shared` `SandboxAPI` interface remains named `SandboxAPI` because it defines the current control API contract used by both sides.
