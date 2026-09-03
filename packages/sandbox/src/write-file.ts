import type { ContainerExecutor, WriteFileOptions } from "./container-files.js";
import { fileErrorFromErrno, fileErrorFromExit, SandboxProtocolError } from "./errors.js";
import { SHIM_PATH, type ShimFrame, ShimOutput, ShimSession } from "./shim.js";

type FailureReason = Parameters<ReadableStreamDefaultReader<Uint8Array>["cancel"]>[0];
type PumpResult =
  | { readonly kind: "complete" }
  | { readonly kind: "sourceFailure"; readonly error: FailureReason }
  | { readonly kind: "inputFailure"; readonly error: FailureReason };
type TerminalResult =
  | { readonly kind: "frame"; readonly frame: ShimFrame }
  | { readonly kind: "failure"; readonly error: FailureReason };

export async function writeFile(
  container: ContainerExecutor,
  path: string,
  source: ReadableStream<Uint8Array>,
  options: WriteFileOptions,
): Promise<void> {
  let session: ShimSession | undefined;
  let output: ShimOutput | undefined;
  let input: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let sourceReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    session = await ShimSession.start(container, [SHIM_PATH, "write", path], {
      ...options,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    output = session.openOutput();
    input = session.openInput();

    const opening = await output.readFrame();
    if (opening.kind === "fileError") await output.expectEnd();
    expectControlFrame(opening, path);

    sourceReader = source.getReader();
    const terminal = terminalResult(session, output, path);
    const pumping = pumpSource(session, sourceReader, input);
    const first = await Promise.race([terminal, pumping]);

    if (first.kind === "frame" || first.kind === "failure") {
      const pump = await pumping;
      if (pump.kind === "sourceFailure") throw pump.error;
      handleTerminal(first, path);
      handlePump(pump);
    } else if (first.kind === "sourceFailure") {
      throw first.error;
    } else if (first.kind === "inputFailure") {
      const result = await terminal;
      if (result.kind === "frame" && result.frame.kind === "fileError") {
        expectControlFrame(result.frame, path);
      }
      if (result.kind === "failure") throw result.error;
      throw first.error;
    } else {
      handleTerminal(await terminal, path);
    }

    const exitCode = await session.waitFor(session.process.exitCode);
    if (exitCode !== 0) throw fileErrorFromExit("writeFile", path, exitCode);

    sourceReader.releaseLock();
    input.releaseLock();
    output.releaseLock();
    session.finish();
  } catch (error) {
    session?.terminate();
    if (input !== undefined) discardInput(input, error);
    output?.discard(error);
    if (sourceReader === undefined) {
      void source.cancel(error).catch(() => undefined);
    } else {
      discardSource(sourceReader, error);
    }
    throw error;
  }
}

async function pumpSource(
  session: ShimSession,
  source: ReadableStreamDefaultReader<Uint8Array>,
  input: WritableStreamDefaultWriter<Uint8Array>,
): Promise<PumpResult> {
  while (true) {
    try {
      await session.waitFor(input.ready);
    } catch (error) {
      return { kind: "inputFailure", error };
    }

    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await session.waitFor(source.read());
    } catch (error) {
      return { kind: "sourceFailure", error };
    }
    if (next.done) {
      try {
        await session.waitFor(input.close());
        return { kind: "complete" };
      } catch (error) {
        return { kind: "inputFailure", error };
      }
    }
    if (!(next.value instanceof Uint8Array)) {
      return {
        kind: "sourceFailure",
        error: new TypeError("writeFile stream chunks must be Uint8Array values"),
      };
    }
    try {
      await session.waitFor(input.write(next.value));
    } catch (error) {
      return { kind: "inputFailure", error };
    }
  }
}

async function terminalResult(
  session: ShimSession,
  output: ShimOutput,
  path: string,
): Promise<TerminalResult> {
  try {
    const frame = await output.readFrame();
    await output.expectEnd();
    return { kind: "frame", frame };
  } catch (error) {
    if (SandboxProtocolError.is(error) && error.reason === "TRUNCATED_FRAME") {
      try {
        const exitCode = await session.waitFor(session.process.exitCode);
        if (exitCode !== 0) {
          return { kind: "failure", error: fileErrorFromExit("writeFile", path, exitCode) };
        }
      } catch (abortReason) {
        return { kind: "failure", error: abortReason };
      }
    }
    return { kind: "failure", error };
  }
}

function handleTerminal(result: TerminalResult, path: string): void {
  if (result.kind === "failure") throw result.error;
  expectControlFrame(result.frame, path);
}

function handlePump(result: PumpResult): void {
  if (result.kind !== "complete") throw result.error;
}

function expectControlFrame(frame: ShimFrame, path: string): void {
  if (frame.kind === "fileError") {
    throw fileErrorFromErrno("writeFile", path, frame.errno, frame.detail);
  }
  if (frame.kind !== "success") {
    throw new SandboxProtocolError({ reason: "UNEXPECTED_FRAME" });
  }
}

function discardInput(input: WritableStreamDefaultWriter<Uint8Array>, reason: FailureReason): void {
  void input.abort(reason).then(
    () => input.releaseLock(),
    () => input.releaseLock(),
  );
}

function discardSource(
  source: ReadableStreamDefaultReader<Uint8Array>,
  reason: FailureReason,
): void {
  void source.cancel(reason).then(
    () => source.releaseLock(),
    () => source.releaseLock(),
  );
}
