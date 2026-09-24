import type { FileOperationOptions } from "./files.js";
import { fileErrorFromErrno, protocolError } from "../shared/errors.js";
import {
  type ContainerExecutor,
  SHIM_PATH,
  ShimControl,
  type ShimControlFrame,
  ShimSession,
} from "../shared/shim.js";

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
      await session.settle();
      throw fileErrorFromErrno({ operation: "readFile", path }, opening.errno, opening.detail);
    }
    if (opening.kind !== "success") {
      throw protocolError("sandbox-shim returned data before file bytes");
    }

    // Container transports may multiplex stdout and stderr over one backpressured stream. Keep
    // draining terminal control concurrently so neither stream can block the other's EOF.
    const terminal = readTerminalControl(control);
    // Preserve error ordering: terminal failures surface after any preceding file bytes.
    void terminal.catch(() => undefined);
    return new Response(responseBody(session, control, output, terminal, path));
  } catch (error) {
    terminateRead(session, control, output, error);
    throw error;
  }
}

function responseBody(
  session: ShimSession,
  control: ShimControl,
  output: ReadableStreamDefaultReader<Uint8Array>,
  terminalFrame: Promise<ShimControlFrame>,
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

        const terminal = await session.waitFor(terminalFrame);
        if (terminal.kind === "fileError") {
          await session.settle();
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

async function readTerminalControl(control: ShimControl): Promise<ShimControlFrame> {
  const frame = await control.readFrame();
  await control.expectEnd();
  return frame;
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
