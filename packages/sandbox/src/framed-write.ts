import { fileErrorFromErrno, fileErrorFromExit, SandboxProtocolError } from "./errors.js";
import { type AbortOutcome, stopProcess } from "./framed-read.js";

const MAGIC = new Uint8Array([0x53, 0x42, 0x58, 0x46]);
const PROTOCOL_VERSION = 1;
const HEADER_LENGTH = 6;
const ERROR_PREFIX_LENGTH = 4;
const MAX_ERROR_MESSAGE_LENGTH = 64 * 1024;

const STATUS_OK = 0;
const STATUS_FILE_ERROR = 1;

type WriteFrame = { kind: "success" } | { kind: "error"; errno: number; detail: string };
type WriteCancellationReason = Parameters<ReadableStreamDefaultReader<Uint8Array>["cancel"]>[0];

export class FramedWrite {
  readonly #process: ExecProcess;
  readonly #stdout: ReadableStreamDefaultReader<Uint8Array>;
  readonly #stdin: WritableStreamDefaultWriter<Uint8Array>;
  readonly #path: string;
  readonly #abort: AbortOutcome | undefined;
  #pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #settled = false;

  private constructor(
    process: ExecProcess,
    stdout: ReadableStreamDefaultReader<Uint8Array>,
    stdin: WritableStreamDefaultWriter<Uint8Array>,
    path: string,
    abort: AbortOutcome | undefined,
  ) {
    this.#process = process;
    this.#stdout = stdout;
    this.#stdin = stdin;
    this.#path = path;
    this.#abort = abort;
  }

  static open(process: ExecProcess, path: string, abort: AbortOutcome | undefined): FramedWrite {
    if (process.stdout === null) {
      abort?.dispose();
      stopProcess(process);
      throw new SandboxProtocolError({ reason: "MISSING_STDOUT" });
    }
    if (process.stdin === null) {
      abort?.dispose();
      stopProcess(process);
      void process.stdout.cancel().catch(() => undefined);
      throw new SandboxProtocolError({ reason: "MISSING_STDIN" });
    }

    return new FramedWrite(
      process,
      process.stdout.getReader(),
      process.stdin.getWriter(),
      path,
      abort,
    );
  }

  async write(source: ReadableStream<Uint8Array>): Promise<void> {
    let sourceReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const opening = await this.#readFrame();
      if (opening.kind === "error") {
        throw fileErrorFromErrno("writeFile", this.#path, opening.errno, opening.detail);
      }

      sourceReader = source.getReader();
      const terminal = this.#readTerminalFrame();
      const pumping = this.#pump(sourceReader);
      void terminal.catch(() => undefined);
      void pumping.catch(() => undefined);

      await Promise.race([terminal, pumping]);
      await pumping;
      await terminal;

      const exitCode = await this.#waitFor(this.#process.exitCode);
      if (exitCode !== 0) {
        throw fileErrorFromExit("writeFile", this.#path, exitCode);
      }

      this.#settled = true;
      this.#abort?.dispose();
      sourceReader.releaseLock();
      this.#stdin.releaseLock();
      this.#stdout.releaseLock();
    } catch (error) {
      this.#terminate(error, source, sourceReader);
      throw error;
    }
  }

  async #pump(source: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    while (true) {
      await this.#waitFor(this.#stdin.ready);
      const next = await this.#waitFor(source.read());
      if (next.done) {
        await this.#waitFor(this.#stdin.close());
        return;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new TypeError("writeFile stream chunks must be Uint8Array values");
      }
      await this.#waitFor(this.#stdin.write(next.value));
    }
  }

  async #readTerminalFrame(): Promise<void> {
    const terminal = await this.#readFrame();
    if (terminal.kind === "error") {
      throw fileErrorFromErrno("writeFile", this.#path, terminal.errno, terminal.detail);
    }
  }

  async #readFrame(): Promise<WriteFrame> {
    const header = await this.#readExactly(HEADER_LENGTH);
    validateHeader(header);

    const status = header[5];
    if (status === STATUS_OK) return { kind: "success" };
    if (status !== STATUS_FILE_ERROR) {
      throw new SandboxProtocolError({ reason: "UNKNOWN_STATUS", status });
    }

    const errnoBytes = await this.#readExactly(ERROR_PREFIX_LENGTH);
    const errno = new DataView(
      errnoBytes.buffer,
      errnoBytes.byteOffset,
      ERROR_PREFIX_LENGTH,
    ).getInt32(0, true);
    if (errno <= 0) {
      throw new SandboxProtocolError({ reason: "INVALID_ERRNO", errnoNumber: errno });
    }
    const detail = await this.#readTextToEnd(MAX_ERROR_MESSAGE_LENGTH);
    return { kind: "error", errno, detail };
  }

  async #readExactly(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let offset = 0;

    while (offset < length) {
      if (this.#pending.length === 0) {
        const next = await this.#waitFor(this.#stdout.read());
        if (next.done) {
          throw new SandboxProtocolError({ reason: "TRUNCATED_FRAME" });
        }
        this.#pending = next.value;
      }

      const count = Math.min(length - offset, this.#pending.length);
      result.set(this.#pending.subarray(0, count), offset);
      this.#pending = this.#pending.subarray(count);
      offset += count;
    }

    return result;
  }

  async #readTextToEnd(limit: number): Promise<string> {
    const chunks: Uint8Array[] = [];
    let length = 0;

    if (this.#pending.length > 0) {
      chunks.push(this.#pending);
      length += this.#pending.length;
      this.#pending = new Uint8Array();
    }

    while (true) {
      if (length > limit) {
        throw new SandboxProtocolError({ reason: "ERROR_MESSAGE_TOO_LARGE", limit });
      }
      const next = await this.#waitFor(this.#stdout.read());
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.length;
    }

    if (length > limit) {
      throw new SandboxProtocolError({ reason: "ERROR_MESSAGE_TOO_LARGE", limit });
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new SandboxProtocolError({ reason: "INVALID_ERROR_MESSAGE", cause });
    }
  }

  #waitFor<Value>(operation: Promise<Value>): Promise<Value> {
    if (this.#abort === undefined) return operation;
    return Promise.race([this.#abort.promise, operation]);
  }

  #terminate(
    reason: WriteCancellationReason,
    source: ReadableStream<Uint8Array>,
    sourceReader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  ): void {
    if (this.#settled) return;

    this.#settled = true;
    this.#abort?.dispose();
    stopProcess(this.#process);
    void this.#stdin.abort(reason).catch(() => undefined);
    void this.#stdout.cancel(reason).catch(() => undefined);
    if (sourceReader === undefined) {
      void source.cancel(reason).catch(() => undefined);
    } else {
      void sourceReader.cancel(reason).catch(() => undefined);
    }
  }
}

function validateHeader(header: Uint8Array): void {
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (header[index] !== MAGIC[index]) {
      throw new SandboxProtocolError({ reason: "INVALID_MAGIC" });
    }
  }
  if (header[4] !== PROTOCOL_VERSION) {
    throw new SandboxProtocolError({
      reason: "UNSUPPORTED_VERSION",
      protocolVersion: header[4],
    });
  }
}
