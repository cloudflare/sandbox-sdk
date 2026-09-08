# About sandboxes

A sandbox is a named Durable Object with an attached Container Instance. The
object is the logical identity. The container is the current physical
execution.

`idFromName("workspace-1")` always selects the same sandbox. That identity
survives container restarts, snapshot restore, and explicit destroy.

## Filesystem and lifecycle

`Files` provides Linux file operations for an attached container. The container
image must provide `/usr/local/bin/sandbox-shim`. Linux filesystem failures
become `SandboxFileError`. Malformed shim output becomes
`SandboxProtocolError`.

The application starts, snapshots, signals, and destroys the container
through `this.ctx.container`. File operations require a running container.

Reusing a named sandbox preserves filesystem state for as long as the
current execution, or a restored snapshot of it, remains. Destroying the
execution without a snapshot discards that state. Starting from an image
creates a new filesystem. Starting from `containerSnapshot` restores a
previous one.

Labels on `start()` are operational metadata. They are not identity and not
authorization. The Durable Object name remains the identity.

## Commands

Request-scoped commands use native `container.exec()`. They are not an
`@cloudflare/sandbox` API. `exec()` returns a live handle after spawn. Linux
work can continue after the creating request ends, but the handle, streams,
and control paths exist only in the current object instance. There is no
generation-scoped recovery API today.

## Deployments

A new Worker version does not replace a running container. The image passed
to `container.start()` is used when an execution starts. If an execution is
already running, it keeps the image it started with.

## Failures

A dropped connection or cancelled stream can fail a filesystem call after it
has partially or completely applied. Do not automatically retry writes,
renames, recursive directory creation, removal, or spawn after an
ambiguous failure.
