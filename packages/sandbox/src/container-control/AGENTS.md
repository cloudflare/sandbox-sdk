# Container control

This directory is the primary home for Sandbox Durable Object to container
control-channel code.

Use role-based names such as `ContainerControlClient`,
`ContainerControlConnection`, and `SandboxControlAPI`. Treat capnweb/RPC as an
implementation detail unless the code directly interacts with capnweb types.

Transport-layer/control-channel capabilities land here and in
`packages/sandbox-container/src/control-plane/`. The legacy route-based
HTTP/WebSocket SDK transports were removed; do not reintroduce them.
