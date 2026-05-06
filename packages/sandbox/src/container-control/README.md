# Container control

This directory owns the primary Sandbox Durable Object to container control path.

The current implementation uses capnweb RPC over a WebSocket connection, but the
architectural boundary is not "RPC". The boundary is the control channel used by
the Sandbox Durable Object to call the sandbox container's control API.

DO-to-container control behavior is implemented here and mirrored in
`packages/sandbox-container/src/control-plane/`.

The shared `@repo/shared` `SandboxAPI` interface remains named `SandboxAPI` because it defines the current control API contract used by both sides.

Do not add new control-plane capabilities to `packages/sandbox/src/clients/transport/`.
That directory contains the route-based HTTP/WebSocket compatibility transports.
