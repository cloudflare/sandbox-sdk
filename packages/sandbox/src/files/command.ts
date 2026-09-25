import type { FileOperationOptions } from "./files.js";
import { fileErrorFromErrno, type FileErrorContext, protocolError } from "../shared/errors.js";
import { type ContainerExecutor, SHIM_PATH, ShimControl, ShimSession } from "../shared/shim.js";

/** One shim file command, before the package turns it into an `exec()` call. */
export interface FileCommand {
  /** Shim command name, such as `read-directory`. */
  name: string;
  /** Paths as the caller gave them. */
  paths: readonly string[];
  /** Flags the shim reads after the paths. */
  flags?: readonly string[];
  options: FileOperationOptions;
}

type FileStdio = Pick<ContainerExecOptions, "stdin" | "stdout" | "stderr">;

/**
 * Starts the shim for one file command. A relative path is joined onto `cwd`, so the shim always
 * receives absolute paths and `exec()` never receives `cwd`: a missing `cwd` then fails the file
 * operation with `ENOENT` instead of failing to start the process. Only `user` and `signal`
 * reach `exec()`.
 */
export function startFileCommand(
  container: ContainerExecutor,
  command: FileCommand,
  stdio: FileStdio,
): Promise<ShimSession> {
  const { cwd, user, signal } = command.options;
  const execOptions: ContainerExecOptions = { ...stdio };
  if (user !== undefined) execOptions.user = user;
  if (signal !== undefined) execOptions.signal = signal;
  const paths = command.paths.map((path) => resolvePath(path, cwd));
  return ShimSession.start(
    container,
    [SHIM_PATH, command.name, ...paths, ...(command.flags ?? [])],
    execOptions,
  );
}

// Joining is exact for Linux path resolution: the kernel resolves `..`, symlinks, and repeated
// slashes in the joined path the same way as after entering `cwd`. `Files` rejects a relative
// path without `cwd`.
function resolvePath(path: string, cwd: string | undefined): string {
  return cwd === undefined || path.startsWith("/") ? path : `${cwd}/${path}`;
}

type FileCommandRequest = FileCommand & { error: FileErrorContext };

export function runFileCommand(
  container: ContainerExecutor,
  request: FileCommandRequest & { expected: "data" },
): Promise<Uint8Array>;
export function runFileCommand(
  container: ContainerExecutor,
  request: FileCommandRequest & { expected: "success" },
): Promise<void>;
export async function runFileCommand(
  container: ContainerExecutor,
  request: FileCommandRequest & { expected: "data" | "success" },
): Promise<Uint8Array | void> {
  const session = await startFileCommand(container, request, {
    stdout: "pipe",
    stderr: "ignore",
  });
  let control: ShimControl | undefined;

  try {
    control = session.openStdoutControl();
    const frame = await control.readFrame();
    await control.expectEnd();
    if (frame.kind === "fileError") {
      await session.settle();
      throw fileErrorFromErrno(request.error, frame.errno, frame.detail);
    }
    if (frame.kind !== request.expected) {
      throw protocolError(
        request.expected === "data"
          ? "sandbox-shim did not return command data"
          : "sandbox-shim did not confirm command completion",
      );
    }

    const exitCode = await session.waitFor(session.process.exitCode);
    if (exitCode !== 0) {
      throw protocolError(`sandbox-shim exited with code ${exitCode}`);
    }

    control.releaseLock();
    session.finish();
    return frame.kind === "data" ? frame.payload : undefined;
  } catch (error) {
    session.terminate();
    control?.discard(error);
    throw error;
  }
}
