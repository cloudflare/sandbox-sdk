# Files API

Package: `@cloudflare/sandbox`

Exports: `Files`, `SandboxFileError`, and `SandboxProtocolError`.

## `new Files(container)`

Read and write files in a running Container. Pass `this.ctx.container` from a Durable Object that has a container attachment.

`Files` does not start or destroy the Container. File operations call `container.exec()` and throw if the Container is not running. The image must include `/usr/local/bin/sandbox-shim`. Turn on `nodejs_compat` so `Files` can read Linux error names through `node:os`.

### `readFile(path, options?): Promise<Response>`

Stream bytes from `path`. Failures can arrive while you read the body.

### `writeFile(path, content, options?): Promise<void>`

Create or truncate `path`, then stream `content` into it. The file opens before a caller stream is consumed. A later failure can leave a partial file.

### `stat(path, options?): Promise<SandboxFileStat>`

Return metadata. Follow the final symlink.

### `lstat(path, options?): Promise<SandboxFileStat>`

Return metadata. Do not follow the final symlink.

| Field        | Type                                                                                             | Description                    |
| ------------ | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| `type`       | `"file" \| "directory" \| "symlink" \| "blockDevice" \| "characterDevice" \| "fifo" \| "socket"` | Linux file type                |
| `size`       | `bigint`                                                                                         | Size in bytes                  |
| `mode`       | `number`                                                                                         | Linux mode, including type     |
| `uid`        | `number`                                                                                         | User ID                        |
| `gid`        | `number`                                                                                         | Group ID                       |
| `accessedAt` | `Date`                                                                                           | Last access time               |
| `modifiedAt` | `Date`                                                                                           | Last content modification time |
| `changedAt`  | `Date`                                                                                           | Last metadata change time      |

### `readDirectory(path, options?): Promise<SandboxDirectoryEntry[]>`

Return immediate entries in native order. The directory path may follow a symlink. Entry types do not. The call does not recurse.

| Field  | Type              | Description                             |
| ------ | ----------------- | --------------------------------------- |
| `name` | `string`          | Child name                              |
| `type` | `SandboxFileType` | Entry type, without following a symlink |

Invalid UTF-8 names throw `SandboxFileError` with `EILSEQ`.

### `mkdir(path, options?): Promise<void>`

Create one directory. With `recursive: true`, create missing parents and accept an existing directory. A failure can leave some parents.

### `rename(source, destination, options?): Promise<void>`

Rename a file, directory, or symlink. Linux replacement rules apply. Cross-filesystem renames fail with `EXDEV`.

### `remove(path, options?): Promise<void>`

Remove a file or symlink. Directories need `recursive: true`. Recursive remove does not follow symlinks. `force: true` ignores a missing target. A failure can leave partial trees.

### Options

| Field    | Type          | Description                                          |
| -------- | ------------- | ---------------------------------------------------- |
| `cwd`    | `string`      | Absolute directory used to resolve a relative `path` |
| `user`   | `string`      | Linux user, or `user:group`                          |
| `signal` | `AbortSignal` | AbortSignal passed through to `container.exec()`     |

These fields are `FileOperationOptions`. `MkdirOptions` also has `recursive`. `RemoveOptions` also has `recursive` and `force`. For `rename`, `cwd` resolves both paths.

`path` must be non-empty and must not contain `NUL`. A relative `path` needs `cwd`. `cwd` must be absolute. Violations throw `TypeError`.

### `FileContent`

`writeFile` accepts `string`, `ArrayBuffer`, `ArrayBufferView`, `Blob`, or `ReadableStream<Uint8Array>`.

## `SandboxFileError`

A Linux filesystem error from the sandbox.

| Field         | Type                                                                                                   | Description                     |
| ------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `name`        | `"SandboxFileError"`                                                                                   | Error name                      |
| `code`        | `` `E${string}` `` \| `"UNKNOWN"`                                                                      | Linux errno name                |
| `operation`   | `"readFile" \| "writeFile" \| "stat" \| "lstat" \| "readDirectory" \| "mkdir" \| "rename" \| "remove"` | Failed call                     |
| `path`        | `string`                                                                                               | Path you passed                 |
| `destination` | `string \| undefined`                                                                                  | Destination for a failed rename |
| `detail`      | `string`                                                                                               | Detail from the shim            |

`SandboxFileError.is(cause)` recognizes local and JSRPC values. It is not a public constructor.

## `SandboxProtocolError`

A bad exchange with `sandbox-shim`.

| Field    | Type                       | Description |
| -------- | -------------------------- | ----------- |
| `name`   | `"SandboxProtocolError"`   | Error name  |
| `code`   | `"SANDBOX_PROTOCOL_ERROR"` | Error code  |
| `detail` | `string`                   | Detail      |

`SandboxProtocolError.is(cause)` recognizes local and JSRPC values. It is not a public constructor.

Container, transport, abort, and source-stream failures are not wrapped.
