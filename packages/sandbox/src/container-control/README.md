# Container control

This directory owns the Sandbox Durable Object to container control path. The
architectural boundary is the control channel between the Sandbox DO and the
container control API; capnweb RPC over a WebSocket is the wire implementation.

DO-to-container control behavior is implemented here and mirrored in
`packages/sandbox-container/src/control-plane/`. The shared
`@repo/shared` `SandboxAPI` interface defines the control API contract used by
both sides.
