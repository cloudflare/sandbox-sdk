# About sandboxes

A sandbox is a named Durable Object with an attached Container Instance. The
object is the logical identity. The container is the current physical
execution.

`idFromName("workspace-1")` always selects the same sandbox. That identity
survives container restarts, snapshot restore, and explicit destroy.

## Filesystem and lifecycle

`Sandbox` exposes `this.files` for Linux filesystem operations. The container
image must provide `/usr/local/bin/sandbox-shim`. Linux filesystem failures
become `SandboxFileError`. Malformed shim output becomes
`SandboxProtocolError`.

The application starts, snapshots, signals, and destroys the container
through `this.ctx.container`. `this.files` requires a running container.

Reusing a named sandbox preserves filesystem state for as long as the
current execution, or a restored snapshot of it, remains. Destroying the
execution without a snapshot discards that state. Starting from an image
creates a new filesystem. Starting from `containerSnapshot` restores a
previous one.

Labels on `start()` are operational metadata. They are not identity and not
authorization. The Durable Object name remains the identity.

## Deployments

A new Worker version does not replace a running container. The image passed
to `container.start()` is used when an execution starts. If an execution is
already running, it keeps the image it started with.

## Failures

A dropped connection or cancelled stream can fail a filesystem call after it
has partially or completely applied. Do not automatically retry writes,
renames, recursive directory creation, or removal after an ambiguous
failure.
