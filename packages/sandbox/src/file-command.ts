import type { ContainerExecutor } from "./container-files.js";
import { fileErrorFromErrno, SandboxProtocolError, type SandboxFileOperation } from "./errors.js";
import { SHIM_PATH, ShimControl, ShimSession } from "./shim.js";

type FileCommandOperation = Extract<
  SandboxFileOperation,
  "stat" | "lstat" | "readDirectory" | "mkdir"
>;

export function runFileCommand(
  container: ContainerExecutor,
  command: readonly string[],
  options: ContainerExecOptions,
  operation: FileCommandOperation,
  path: string,
  expected: "data",
): Promise<Uint8Array>;
export function runFileCommand(
  container: ContainerExecutor,
  command: readonly string[],
  options: ContainerExecOptions,
  operation: FileCommandOperation,
  path: string,
  expected: "success",
): Promise<void>;
export async function runFileCommand(
  container: ContainerExecutor,
  command: readonly string[],
  options: ContainerExecOptions,
  operation: FileCommandOperation,
  path: string,
  expected: "data" | "success",
): Promise<Uint8Array | void> {
  const session = await ShimSession.start(container, [SHIM_PATH, ...command], {
    ...options,
    stdout: "pipe",
    stderr: "ignore",
  });
  let control: ShimControl | undefined;

  try {
    control = session.openStdoutControl();
    const frame = await control.readFrame();
    await control.expectEnd();
    if (frame.kind === "fileError") {
      throw fileErrorFromErrno(operation, path, frame.errno, frame.detail);
    }
    if (frame.kind !== expected) {
      throw new SandboxProtocolError({
        detail:
          expected === "data"
            ? "sandbox-shim did not return command data"
            : "sandbox-shim did not confirm command completion",
      });
    }

    const exitCode = await session.waitFor(session.process.exitCode);
    if (exitCode !== 0) {
      throw new SandboxProtocolError({ detail: `sandbox-shim exited with code ${exitCode}` });
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
