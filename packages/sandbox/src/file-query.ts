import type { ContainerExecutor } from "./container-files.js";
import { fileErrorFromErrno, SandboxProtocolError, type SandboxFileOperation } from "./errors.js";
import { SHIM_PATH, ShimControl, ShimSession } from "./shim.js";

type FileQueryOperation = Extract<SandboxFileOperation, "stat" | "lstat" | "readDirectory">;

export async function runFileQuery(
  container: ContainerExecutor,
  command: readonly string[],
  options: ContainerExecOptions,
  operation: FileQueryOperation,
  path: string,
): Promise<Uint8Array> {
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
    if (frame.kind !== "data") {
      throw new SandboxProtocolError({ detail: "sandbox-shim did not return command data" });
    }

    const exitCode = await session.waitFor(session.process.exitCode);
    if (exitCode !== 0) {
      throw new SandboxProtocolError({ detail: `sandbox-shim exited with code ${exitCode}` });
    }

    control.releaseLock();
    session.finish();
    return frame.payload;
  } catch (error) {
    session.terminate();
    control?.discard(error);
    throw error;
  }
}
