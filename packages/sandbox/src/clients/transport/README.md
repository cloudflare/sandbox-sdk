# Route-based compatibility transports

This directory implements the HTTP and custom WebSocket transports for the
route-based container API.

These transports are maintained for compatibility, debugging, local development,
and fallback behavior. They are not the primary extension point for Sandbox
Durable Object to container control-channel work.

Transport-layer/control-channel capabilities belong in
`packages/sandbox/src/container-control/` and
`packages/sandbox-container/src/control-plane/`.

Only make changes here when:

- maintaining an existing HTTP/WebSocket compatibility behavior;
- preserving behavior for route-based clients;
- maintaining startup/retry behavior shared by existing route-based clients.
