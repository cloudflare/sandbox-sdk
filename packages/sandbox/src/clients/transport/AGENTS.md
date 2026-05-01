# Route-based compatibility transports

This directory is compatibility-only for the HTTP and custom WebSocket
route-based API.

Do not add transport-layer capabilities here unless the task explicitly requires
HTTP/WebSocket compatibility maintenance. DO-to-container control-channel work
belongs in `packages/sandbox/src/container-control/` and the matching container
API belongs in `packages/sandbox-container/src/control-plane/`.
