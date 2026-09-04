# About sandboxes

A sandbox is a named Durable Object with an attached Container Instance. The
object is the logical identity. The container is the current physical execution.

`idFromName("workspace-1")` always selects the same sandbox. That identity
survives container restarts, snapshot restore, and explicit destroy. The
platform chooses when a physical execution exists. The application chooses when
to start, snapshot, stop, or destroy it.

## What the SDK owns

The SDK provides filesystem access between the Worker and a matching
`sandbox-shim` in the container. It maps Linux filesystem failures to
`SandboxFileError` and protocol mismatches to `SandboxProtocolError`. It does
not decide when the container runs.

That split stays useful as the SDK grows. Process execution, terminals, or
other container capabilities can sit beside `this.files` without turning
`Sandbox` into a wrapper around the Container Instance API.

## What the platform owns

`this.ctx.container` is the native Container Instance. Start, inspect, snapshot,
restore, labels, inactivity, signals, monitor, and destroy remain platform
methods. The SDK does not retry, time out, or classify those failures.

A snapshot ID is a platform artifact. The application decides which snapshot is
the active checkpoint for a sandbox, usually by storing the ID in Durable Object
storage. The platform does not remember that policy.

## Isolation and reuse

Reusing a named sandbox preserves filesystem state for as long as the current
execution, or a restored snapshot of it, remains. Destroying the execution
without a snapshot discards that state. Starting from the image creates a new
filesystem. Starting from `containerSnapshot` restores a previous one.

Labels on `start()` are operational metadata. They are not identity and not
authorization. The Durable Object name remains the identity.
