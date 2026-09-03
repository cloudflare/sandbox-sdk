import type { ContainerExecutor, WriteFileOptions } from "./container-files.js";
import { fileErrorFromErrno, SandboxProtocolError } from "./errors.js";
import { SHIM_PATH, type ShimControlFrame, ShimControl, ShimSession } from "./shim.js";

type FailureReason = Parameters<ReadableStreamDefaultReader<Uint8Array>["cancel"]>[0];
type PumpResult =
  | { readonly kind: "complete" }
  | { readonly kind: "sourceFailure"; readonly error: FailureReason }
  | { readonly kind: "inputFailure"; readonly error: FailureReason };
type TerminalResult =
  | { readonly kind: "frame"; readonly frame: ShimControlFrame }
  | { readonly kind: "failure"; readonly error: FailureReason };

export async function writeFile(
  container: ContainerExecutor,
  path: string,
  source: ReadableStream<Uint8Array>,
  options: WriteFileOptions,
): Promise<void> {
  let session: ShimSession | undefined;
  let control: ShimControl | undefined;
  let input: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let sourceReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    session = await ShimSession.start(container, [SHIM_PATH, "write", path], {
      ...options,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    control = session.openOutputControl();
    input = session.openInput();

    const opening = await control.readFrame();
    if (opening.kind === "fileError") await control.expectEnd();
    expectSuccess(opening, path);

    sourceReader = source.getReader();
    const terminal = terminalResult(session, control);
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
        expectSuccess(result.frame, path);
      }
      if (result.kind === "failure") throw result.error;
      throw first.error;
    } else {
      handleTerminal(await terminal, path);
    }

    const exitCode = await session.waitFor(session.process.exitCode);
    if (exitCode !== 0) {
      throw new SandboxProtocolError({ detail: `sandbox-shim exited with code ${exitCode}` });
    }

    sourceReader.releaseLock();
    input.releaseLock();
    control.releaseLock();
    session.finish();
  } catch (error) {
    session?.terminate();
    if (input !== undefined) discardInput(input, error);
    control?.discard(error);
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

async function terminalResult(session: ShimSession, control: ShimControl): Promise<TerminalResult> {
  try {
    const frame = await control.readFrame();
    await control.expectEnd();
    return { kind: "frame", frame };
  } catch (error) {
    return { kind: "failure", error };
  }
}

function handleTerminal(result: TerminalResult, path: string): void {
  if (result.kind === "failure") throw result.error;
  expectSuccess(result.frame, path);
}

function handlePump(result: PumpResult): void {
  if (result.kind !== "complete") throw result.error;
}

function expectSuccess(frame: ShimControlFrame, path: string): void {
  if (frame.kind === "fileError") {
    throw fileErrorFromErrno("writeFile", path, frame.errno, frame.detail);
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
