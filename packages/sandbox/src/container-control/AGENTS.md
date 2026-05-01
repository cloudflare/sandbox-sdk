# Container control

This directory is the primary home for Sandbox Durable Object to container
control-channel code.

Use role-based names such as `ContainerControlClient`,
`ContainerControlConnection`, and `SandboxControlAPI`. Treat capnweb/RPC as an
implementation detail unless the code directly interacts with capnweb types.

Transport-layer/control-channel capabilities land here and in
`packages/sandbox-container/src/control-plane/`. Do not add capabilities to the
route-based HTTP/WebSocket compatibility transports unless the task is explicitly
compatibility maintenance.
