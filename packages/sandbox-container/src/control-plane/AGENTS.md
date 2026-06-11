# Control plane

This directory is the primary home for container-side control API methods used
by the Sandbox Durable Object.

Add control operations here and call service methods directly. Keep `/rpc` as
the external WebSocket route unless a task explicitly changes the wire protocol.
