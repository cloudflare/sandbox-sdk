import type { ContainerExecutor } from "./container-files.js";
import { fileErrorFromErrno, type FileErrorContext, protocolError } from "./errors.js";
import { SHIM_PATH, ShimControl, ShimSession } from "./shim.js";

interface FileCommandRequest {
  command: readonly string[];
  options: ContainerExecOptions;
  error: FileErrorContext;
}

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
  const session = await ShimSession.start(container, [SHIM_PATH, ...request.command], {
    ...request.options,
    stdout: "pipe",
    stderr: "ignore",
  });
  let control: ShimControl | undefined;

  try {
    control = session.openStdoutControl();
    const frame = await control.readFrame();
    await control.expectEnd();
    if (frame.kind === "fileError") {
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
