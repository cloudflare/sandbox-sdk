import type { FileOperationOptions } from "./files.js";
import { startFileCommand } from "./command.js";
import { fileErrorFromErrno, protocolError } from "../shared/errors.js";
import {
  type ContainerExecutor,
  ShimControl,
  type ShimControlFrame,
  type ShimSession,
} from "../shared/shim.js";

type CancellationReason = Parameters<ReadableStreamDefaultReader<Uint8Array>["cancel"]>[0];

export async function readFile(
  container: ContainerExecutor,
  path: string,
  options: FileOperationOptions,
): Promise<Response> {
  const session = await startFileCommand(
    container,
    { name: "read", paths: [path], options },
    { stdout: "pipe", stderr: "pipe" },
  );
  let control: ShimControl | undefined;
  let stdout: StdoutReader | undefined;

  try {
    control = session.openStderrControl();
    stdout = new StdoutReader(session.openStdoutReader());
    const opening = await control.readFrame();
    stdout.stopReadingAhead();
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
    return new Response(responseBody(session, control, stdout, terminal, path));
  } catch (error) {
    terminateRead(session, control, stdout, error);
    throw error;
  }
}

/**
 * Reads the shim's stdout, reading ahead until `readFile` has the opening frame from stderr.
 *
 * A container transport can carry stdout and stderr over one connection with shared backpressure,
 * and can deliver file bytes before the opening frame, or between its fragments. The rest of the
 * frame then arrives only after something reads stdout. The shim writes the whole opening frame
 * before any file byte, so the read-ahead stops once that frame is complete. After that, the
 * response body reads stdout on demand, so the caller's pace applies backpressure again.
 *
 * The read-ahead has no size limit, because stopping before the frame is complete would bring the
 * hang back. How much it holds depends on how far the transport lets stdout run ahead of stderr.
 */
class StdoutReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #chunks: Uint8Array[] = [];
  #pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  #readingAhead = true;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
    this.#readNext();
  }

  /** Stops reading ahead. Chunks already read stay queued for `read()`. */
  stopReadingAhead(): void {
    this.#readingAhead = false;
  }

  read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    const chunk = this.#chunks.shift();
    if (chunk !== undefined) return Promise.resolve({ done: false, value: chunk });
    const pending = this.#pending ?? this.#reader.read();
    this.#pending = undefined;
    return pending;
  }

  discard(reason: CancellationReason): void {
    void this.#reader.cancel(reason).then(
      () => this.#reader.releaseLock(),
      () => this.#reader.releaseLock(),
    );
  }

  releaseLock(): void {
    this.#reader.releaseLock();
  }

  #readNext(): void {
    const read = this.#reader.read();
    this.#pending = read;
    // End of stream and failures stay in #pending, so read() reports them after queued chunks.
    read.then(
      (result) => {
        // read() has taken this read over.
        if (this.#pending !== read || result.done) return;
        this.#pending = undefined;
        this.#chunks.push(result.value);
        if (this.#readingAhead) this.#readNext();
      },
      () => undefined,
    );
  }
}

function responseBody(
  session: ShimSession,
  control: ShimControl,
  stdout: StdoutReader,
  terminalFrame: Promise<ShimControlFrame>,
  path: string,
) {
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const next = await session.waitFor(stdout.read());
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

        stdout.releaseLock();
        control.releaseLock();
        session.finish();
        controller.close();
      } catch (error) {
        terminateRead(session, control, stdout, error);
        controller.error(error);
      }
    },
    cancel: (reason: CancellationReason) => terminateRead(session, control, stdout, reason),
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
  stdout: StdoutReader | undefined,
  reason: CancellationReason,
): void {
  session.terminate();
  control?.discard(reason);
  stdout?.discard(reason);
}
