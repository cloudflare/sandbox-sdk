# Shim protocol

This page describes how `@cloudflare/sandbox` and `sandbox-shim` talk to each other. The package starts the shim with `exec()` as `/usr/local/bin/sandbox-shim <command> <arguments>`, one process per operation. For why the shim exists, see [Architecture](architecture.md).

The Rust side is `crates/sandbox-tools/src/protocol.rs`. The TypeScript side is `packages/sandbox/src/shared/shim.ts`.

## Frames

Control information travels in frames. Every frame starts with a 10-byte header:

| Bytes | Field          | Value                                 |
| ----- | -------------- | ------------------------------------- |
| 0–3   | Magic          | `SBXF` (`53 42 58 46`)                |
| 4     | Version        | `1`                                   |
| 5     | Kind           | `0` success, `1` file error, `2` data |
| 6–9   | Payload length | `u32`, little-endian                  |

The payload follows the header:

- Success has an empty payload. Any other length is a protocol error.
- File error is an `i32` little-endian errno, then the error detail as UTF-8. The errno must be positive. When a Rust `io::Error` has no OS error, the shim sends `EIO` (5). The package rejects details longer than 64 KiB and details that are not valid UTF-8.
- Data is an operation-specific payload, described in [Data payloads](#data-payloads).

The package turns a file error into `SandboxFileError`, and anything malformed into `SandboxProtocolError`: wrong magic, another version, an unknown kind, a truncated frame, or bytes after the last expected frame.

## Commands

| Operation       | Arguments                                       | stdin                               | stdout               | stderr         |
| --------------- | ----------------------------------------------- | ----------------------------------- | -------------------- | -------------- |
| `readFile`      | `read <PATH>`                                   | Not used                            | File bytes, unframed | Control frames |
| `writeFile`     | `write <PATH>`                                  | File bytes, unframed                | Control frames       | Ignored        |
| `stat`, `lstat` | `stat <PATH>`, `lstat <PATH>`                   | Not used                            | One control frame    | Ignored        |
| `readDirectory` | `read-directory <PATH>`                         | Not used                            | One control frame    | Ignored        |
| `mkdir`         | `mkdir <PATH> [--recursive]`                    | Not used                            | One control frame    | Ignored        |
| `rename`        | `rename <SOURCE> <DESTINATION>`                 | Not used                            | One control frame    | Ignored        |
| `remove`        | `remove <PATH> [--recursive] [--force]`         | Not used                            | One control frame    | Ignored        |
| `S3Mounts`      | `s3-mount <mount\|inspect\|unmount> <ARGUMENT>` | One byte, for `mount` and `unmount` | JSON in data frames  | Ignored        |

Relative paths resolve against the `cwd` that the package passes to `exec()`. The shim does not change the path.

When the arguments are wrong, the shim writes `sandbox-shim: <message>` to stderr and exits with code `1` without sending a frame. The package then reports a protocol error: invalid magic for a read, whose stderr carries frames, or truncated control data for the other commands.

### One-shot commands

`stat`, `lstat`, `read-directory`, `mkdir`, `rename`, and `remove` send exactly one frame on stdout and then end the stream:

- A data frame for `stat`, `lstat`, and `read-directory`.
- A success frame for `mkdir`, `rename`, and `remove`.
- A file error frame for any of them.

After a data or success frame, the package also requires exit code `0`. `packages/sandbox/src/files/command.ts` implements this for all six commands.

### `read`

1. The shim opens the file and sends success or a file error on stderr.
2. After success, it copies the file to stdout in 8 KiB reads. The package returns a `Response` whose body reads stdout, so the reader's pace applies backpressure to the shim.
3. At end of file, the shim sends success on stderr. If a read fails partway, it sends a file error instead, and the package errors the response body with that `SandboxFileError` after the bytes that came before it.

File bytes travel unframed, because Web Streams already provide ordering, backpressure, and end of stream. The package reads stderr while the body is being read, not only after stdout ends, because the container transport can carry both streams over one connection with shared backpressure.

### `write`

1. The shim creates or truncates the file, then sends success or a file error on stdout. It does not read stdin before this frame, so a file that cannot be opened never consumes the caller's stream.
2. After success, the package copies the source stream to stdin and closes stdin at the end of the stream.
3. The shim writes each chunk to the file. On a write error, it sends a file error and stops reading. After end of input and a successful flush, it sends success.
4. After success, the package requires exit code `0`.

The package copies with an explicit read-and-write loop instead of `source.pipeTo(process.stdin)`. In production, `pipeTo()` into container stdin has rejected with `Network connection lost.` after the container accepted every byte. The loop also keeps each failure's origin.

The package waits for the copy and the shim's final frame at the same time, so a file error can end the call while the source is still waiting for data. When both fail, the package reports:

- The file error, when it arrives first.
- The source stream's own error, when the source fails first.
- The shim's file error when writing to stdin fails and the shim reports one. Otherwise, the stdin error.

## Data payloads

All integers are little-endian.

`stat` and `lstat` send 45 bytes:

| Offset | Type  | Field                                          |
| ------ | ----- | ---------------------------------------------- |
| 0      | `u8`  | File type                                      |
| 1      | `u64` | Size in bytes                                  |
| 9      | `u32` | Mode, including the file type bits             |
| 13     | `u32` | User ID                                        |
| 17     | `u32` | Group ID                                       |
| 21     | `i64` | Access time, milliseconds since the Unix epoch |
| 29     | `i64` | Modification time, milliseconds                |
| 37     | `i64` | Status change time, milliseconds               |

`read-directory` sends a `u32` entry count, then each entry as a `u8` file type, a `u16` name length, and the name bytes. Entries keep the order Linux returns them in. A name that is not valid UTF-8 fails the whole call with `EILSEQ`, because JavaScript strings cannot represent it.

File types are `0` file, `1` directory, `2` symlink, `3` block device, `4` character device, `5` FIFO, and `6` socket.

## `s3-mount`

Each data frame carries one JSON envelope: `{"ok": true, "value": ...}` or `{"ok": false, "error": {"kind": ..., "detail": ...}}`. The kinds `busy`, `conflict`, `failed`, and `incompatible` become `SandboxS3MountError` codes. The kind `protocol` becomes `SandboxProtocolError`.

- `inspect <MOUNT_PATH>` sends one envelope with the guest state and, for a mount with a marker, the result of a request through its gateway route.
- `mount <REQUEST_JSON>` sends `{"kind": "route", "routeId": ...}` first. The package installs the outbound route for that ID and writes one byte, `1`, to stdin. The shim then starts or adopts the mount and sends a final envelope whose value is `null`.
- `unmount <MOUNT_PATH>` sends `null` right away when nothing is mounted. Otherwise it sends the route first, the package replaces the route with a gateway that denies every request, and the shim unmounts after the acknowledgement byte.

For `mount` and `unmount`, the shim holds a lock on the mount path for the whole exchange. `inspect` takes the lock only to read the guest state. For why mounts work this way, see [S3 mounts design](s3-mounts-design.md).

## Cancellation and cleanup

The package passes the caller's `AbortSignal` to `exec()`, which kills the shim, and rejects with the signal's reason. It stops following the signal once the operation finishes, because `AbortSignal.timeout()` can fire long after the call ends and signaling an exited process logs a runtime error.

After the shim reports a file error, the package waits for the process to exit before it rejects, so it does not signal a process that has already exited. On any other failure, the package kills the shim with signal `9` and cancels the streams it holds.

## Versioning

The version byte catches a package and a shim from different releases. There is no negotiation: the package accepts version `1` only and reports `sandbox-shim protocol <N> is not supported` for any other.

Increase the version when an existing command changes its frames, payloads, or arguments in a way the other side would misread. A new command does not need a new version, because an old shim rejects an unknown command without sending a frame.

Application images copy the shim from a donor image whose tag matches the package version, which keeps the two sides in step. `S3Mounts` has a separate version number for its request, marker, and gateway formats.

## Add a file operation

1. Add a module under `crates/sandbox-tools/src/files/`, dispatch to it in `files/mod.rs`, and send frames with the helpers in `protocol.rs`. Add Rust unit tests next to it.
2. Add the method to `Files` in `packages/sandbox/src/files/files.ts`. Call `validatePath()` for each path. Use `runFileCommand()` when the operation sends one frame, and add a decoder when it sends data.
3. Add the operation name to `FILE_OPERATIONS` in `packages/sandbox/src/shared/errors.ts`. If the operation takes a second path, add it to `FileErrorContext`, as `rename` does.
4. Add package tests that feed frames from `packages/sandbox/tests/helpers.ts`, a case in `packages/sandbox/tests/shim-contract.test.mjs`, which runs the package against the compiled shim, and a subprocess test in `crates/sandbox-tools/tests/shim.rs` if the command needs one.
5. Export any new public types from `packages/sandbox/src/index.ts`.
6. Document the method in the [Files API reference](https://developers.cloudflare.com/sandbox/reference/files/).
