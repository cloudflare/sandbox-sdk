import type { ContainerExecutor, ReadFileOptions } from "./container-files.js";
import { fileErrorFromErrno, fileErrorFromExit, SandboxProtocolError } from "./errors.js";
import { SHIM_PATH, ShimOutput, ShimSession } from "./shim.js";

type CancellationReason = Parameters<ReadableStreamDefaultReader<Uint8Array>["cancel"]>[0];

export async function readFile(
  container: ContainerExecutor,
  path: string,
  options: ReadFileOptions,
): Promise<Response> {
  const session = await ShimSession.start(container, [SHIM_PATH, "read", path], {
    ...options,
    stdout: "pipe",
    stderr: "ignore",
  });
  let output: ShimOutput | undefined;

  try {
    output = session.openOutput();
    const opening = await output.readFrame();
    if (opening.kind === "fileError") {
      await output.expectEnd();
      throw fileErrorFromErrno("readFile", path, opening.errno, opening.detail);
    }
    if (opening.kind !== "success") {
      throw new SandboxProtocolError({ reason: "UNEXPECTED_FRAME" });
    }

    const body = responseBody(session, output, path);
    return new Response(body, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  } catch (error) {
    session.terminate();
    output?.discard(error);
    throw error;
  }
}

function responseBody(session: ShimSession, output: ShimOutput, path: string) {
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const frame = await output.readFrame();
        if (frame.kind === "data") {
          controller.enqueue(frame.value);
          return;
        }
        if (frame.kind === "fileError") {
          await output.expectEnd();
          throw fileErrorFromErrno("readFile", path, frame.errno, frame.detail);
        }

        await output.expectEnd();
        const exitCode = await session.waitFor(session.process.exitCode);
        if (exitCode !== 0) {
          throw fileErrorFromExit("readFile", path, exitCode);
        }

        output.releaseLock();
        session.finish();
        controller.close();
      } catch (error) {
        let failure = error;
        if (SandboxProtocolError.is(error) && error.reason === "TRUNCATED_FRAME") {
          try {
            const exitCode = await session.waitFor(session.process.exitCode);
            if (exitCode !== 0) failure = fileErrorFromExit("readFile", path, exitCode);
          } catch (abortReason) {
            failure = abortReason;
          }
        }
        terminateRead(session, output, failure);
        controller.error(failure);
      }
    },
    cancel: (reason: CancellationReason) => terminateRead(session, output, reason),
  });
}

function terminateRead(session: ShimSession, output: ShimOutput, reason: CancellationReason): void {
  session.terminate();
  output.discard(reason);
}
