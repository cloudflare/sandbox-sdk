# Sandbox SDK reference

Package: `@cloudflare/sandbox`

The package exports `Sandbox`, `ContainerFiles`, `SandboxFileError`,
`SandboxProtocolError`, and the types listed below.

## `Sandbox<Env, Props = {}>`

Abstract Durable Object base class. The constructor requires
`ctx.container`. It throws if the Durable Object is not container-enabled.

| Member  | Type             | Description                                     |
| ------- | ---------------- | ----------------------------------------------- |
| `files` | `ContainerFiles` | File operations against the attached container. |

`Sandbox` does not wrap Container Instance lifecycle. Use `this.ctx.container`.

## `ContainerFiles`

Constructed with a container that exposes `exec`. The container image must
provide `/usr/local/bin/sandbox-shim`.

### `readFile(path, options?): Promise<Response>`

Streams bytes from `path` as a binary `Response`. The body applies backpressure
to the container process. A filesystem or transport failure can surface while
the body is consumed.

### `writeFile(path, content, options?): Promise<void>`

Creates or truncates `path` and streams `content` into it. The destination is
opened before a caller-provided stream is consumed. A later failure can leave a
created, truncated, or partially written file.

### `stat(path, options?): Promise<SandboxFileStat>`

Returns metadata for a path, following its final symlink.

### `lstat(path, options?): Promise<SandboxFileStat>`

Returns metadata without following the path's final symlink.

| Field        | Type                                                                                             | Description                      |
| ------------ | ------------------------------------------------------------------------------------------------ | -------------------------------- |
| `type`       | `"file" \| "directory" \| "symlink" \| "blockDevice" \| "characterDevice" \| "fifo" \| "socket"` | Native Linux file type.          |
| `size`       | `bigint`                                                                                         | Size in bytes.                   |
| `mode`       | `number`                                                                                         | Full Linux mode, including type. |
| `uid`        | `number`                                                                                         | Numeric Linux user ID.           |
| `gid`        | `number`                                                                                         | Numeric Linux group ID.          |
| `accessedAt` | `Date`                                                                                           | Last access time.                |
| `modifiedAt` | `Date`                                                                                           | Last content modification time.  |
| `changedAt`  | `Date`                                                                                           | Last metadata change time.       |

### `readDirectory(path, options?): Promise<SandboxDirectoryEntry[]>`

Returns all immediate entries in native enumeration order. The directory path
may resolve through a symlink, but entry types describe the entries themselves
and do not follow symlinks. The operation does not recurse or retrieve full
metadata for each child.

| Field  | Type              | Description                      |
| ------ | ----------------- | -------------------------------- |
| `name` | `string`          | Immediate child's UTF-8 name.    |
| `type` | `SandboxFileType` | Non-following native entry type. |

Directory names that are not valid UTF-8 produce `SandboxFileError` with
`EILSEQ`.

### `mkdir(path, options?): Promise<void>`

Creates one directory by default. With `recursive: true`, it creates missing
parents and accepts an existing target directory. Recursive creation is not
transactional; failure or cancellation can leave some parent directories.

### `rename(source, destination, options?): Promise<void>`

Renames a file, directory, or symlink. Native Linux replacement rules apply.
Cross-filesystem renames reject with `EXDEV`; the SDK does not fall back to
copying and removing the source.

### Options

| Field    | Type          | Description                                                   |
| -------- | ------------- | ------------------------------------------------------------- |
| `cwd`    | `string`      | Absolute working directory used to resolve a relative `path`. |
| `user`   | `string`      | Linux user, or `user:group`, used to open the file.           |
| `signal` | `AbortSignal` | Cancels the native container process.                         |

`MkdirOptions` also accepts `recursive?: boolean`. `RenameOptions` uses the
common options above; `cwd` resolves both relative paths.

`path` must be non-empty and must not contain `NUL`. Relative `path` requires
`cwd`. `cwd`, when set, must be absolute. Violations throw `TypeError`.

### `FileContent`

`writeFile` accepts `string`, `ArrayBuffer`, `ArrayBufferView`, `Blob`, or
`ReadableStream<Uint8Array>`.

## `SandboxFileError`

A Linux filesystem failure reported by the container.

| Field         | Type                                                                                                   | Description                             |
| ------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `name`        | `"SandboxFileError"`                                                                                   | Error name.                             |
| `code`        | `` `E${string}` `` \| `"UNKNOWN"`                                                                      | Symbolic errno, or `UNKNOWN`.           |
| `errno`       | `number`                                                                                               | Positive Linux errno.                   |
| `operation`   | `"readFile"` \| `"writeFile"` \| `"stat"` \| `"lstat"` \| `"readDirectory"` \| `"mkdir"` \| `"rename"` | Failed operation.                       |
| `path`        | `string`                                                                                               | Path passed to the operation.           |
| `destination` | `string \| undefined`                                                                                  | Destination path for a failed `rename`. |
| `detail`      | `string`                                                                                               | Failure detail from the shim.           |

`SandboxFileError.is(cause)` is true for local and JSRPC-crossed values.

## `SandboxProtocolError`

An incompatible or malformed exchange with `sandbox-shim`.

| Field    | Type                       | Description        |
| -------- | -------------------------- | ------------------ |
| `name`   | `"SandboxProtocolError"`   | Error name.        |
| `code`   | `"SANDBOX_PROTOCOL_ERROR"` | Stable error code. |
| `detail` | `string`                   | Failure detail.    |

`SandboxProtocolError.is(cause)` is true for local and JSRPC-crossed values.

Native container, transport, abort, and source-stream failures are not wrapped.
