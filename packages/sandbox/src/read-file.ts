import type { ContainerExecutor, FileOperationOptions } from "./container-files.js";
import { fileErrorFromErrno, protocolError } from "./errors.js";
import { SHIM_PATH, ShimControl, ShimSession } from "./shim.js";

type CancellationReason = Parameters<ReadableStreamDefaultReader<Uint8Array>["cancel"]>[0];

export async function readFile(
  container: ContainerExecutor,
  path: string,
  options: FileOperationOptions,
): Promise<Response> {
  const session = await ShimSession.start(container, [SHIM_PATH, "read", path], {
    ...options,
    stdout: "pipe",
    stderr: "pipe",
  });
  let control: ShimControl | undefined;
  let output: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    control = session.openStderrControl();
    output = session.openStdoutReader();
    const opening = await control.readFrame();
    if (opening.kind === "fileError") {
      await control.expectEnd();
      throw fileErrorFromErrno({ operation: "readFile", path }, opening.errno, opening.detail);
    }
    if (opening.kind !== "success") {
      throw protocolError("sandbox-shim returned data before file bytes");
    }

    return new Response(responseBody(session, control, output, path), {
      headers: { "Content-Type": "application/octet-stream" },
    });
  } catch (error) {
    terminateRead(session, control, output, error);
    throw error;
  }
}

function responseBody(
  session: ShimSession,
  control: ShimControl,
  output: ReadableStreamDefaultReader<Uint8Array>,
  path: string,
) {
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const next = await session.waitFor(output.read());
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }

        const terminal = await control.readFrame();
        await control.expectEnd();
        if (terminal.kind === "fileError") {
          throw fileErrorFromErrno(
            { operation: "readFile", path },
            terminal.errno,
            terminal.detail,
          );
        }
        if (terminal.kind !== "success") {
          throw protocolError("sandbox-shim returned data after file bytes");
        }

        output.releaseLock();
        control.releaseLock();
        session.finish();
        controller.close();
      } catch (error) {
        terminateRead(session, control, output, error);
        controller.error(error);
      }
    },
    cancel: (reason: CancellationReason) => terminateRead(session, control, output, reason),
  });
}

function terminateRead(
  session: ShimSession,
  control: ShimControl | undefined,
  output: ReadableStreamDefaultReader<Uint8Array> | undefined,
  reason: CancellationReason,
): void {
  session.terminate();
  control?.discard(reason);
  if (output !== undefined) {
    void output.cancel(reason).then(
      () => output.releaseLock(),
      () => output.releaseLock(),
    );
  }
}
