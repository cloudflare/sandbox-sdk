import { SandboxProtocolError } from "./errors.js";

const MAGIC = new Uint8Array([0x53, 0x42, 0x58, 0x46]);
const PROTOCOL_VERSION = 1;
const HEADER_LENGTH = 6;
const ERROR_PREFIX_LENGTH = 4;
const MAX_ERROR_MESSAGE_LENGTH = 64 * 1024;

const STATUS_OK = 0;
const STATUS_FILE_ERROR = 1;

type StreamCancellationReason = Parameters<ReadableStreamDefaultReader<Uint8Array>["cancel"]>[0];

type ReadFrame = { kind: "content" } | { kind: "error"; errno: number; detail: string };

export class FramedRead {
  readonly #process: ExecProcess;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #signal: AbortSignal | undefined;
  #pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #settled = false;

  private constructor(
    process: ExecProcess,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal | undefined,
  ) {
    this.#process = process;
    this.#reader = reader;
    this.#signal = signal;
  }

  static open(process: ExecProcess, signal: AbortSignal | undefined): FramedRead {
    if (process.stdout === null) {
      stopProcess(process);
      throw new SandboxProtocolError({ reason: "MISSING_STDOUT" });
    }

    return new FramedRead(process, process.stdout.getReader(), signal);
  }

  async readFrame(): Promise<ReadFrame> {
    try {
      return await this.#readFrame();
    } catch (error) {
      if (this.#signal?.aborted === true) throw this.#signal.reason;
      throw error;
    }
  }

  async #readFrame(): Promise<ReadFrame> {
    const header = await this.#readExactly(HEADER_LENGTH);
    validateHeader(header);

    const status = header[5];
    if (status === STATUS_OK) {
      return { kind: "content" };
    }
    if (status !== STATUS_FILE_ERROR) {
      throw new SandboxProtocolError({ reason: "UNKNOWN_STATUS", status });
    }

    const errnoBytes = await this.#readExactly(ERROR_PREFIX_LENGTH);
    const errno = new DataView(
      errnoBytes.buffer,
      errnoBytes.byteOffset,
      ERROR_PREFIX_LENGTH,
    ).getInt32(0, true);
    const detail = await this.#readTextToEnd(MAX_ERROR_MESSAGE_LENGTH);
    return { kind: "error", errno, detail };
  }

  body(): ReadableStream<Uint8Array> {
    let pending: Uint8Array | undefined = this.#pending.length > 0 ? this.#pending : undefined;
    this.#pending = new Uint8Array();

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (pending !== undefined) {
          controller.enqueue(pending);
          pending = undefined;
          return;
        }

        try {
          const next = await this.#reader.read();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }

          const exitCode = await this.#process.exitCode;
          if (exitCode !== 0) {
            if (this.#signal?.aborted === true) throw this.#signal.reason;
            throw new SandboxProtocolError({ reason: "UNEXPECTED_EXIT", exitCode });
          }

          this.#settled = true;
          controller.close();
        } catch (error) {
          const failure = this.#signal?.aborted === true ? this.#signal.reason : error;
          this.terminate(failure);
          controller.error(failure);
        }
      },
      cancel: (reason) => {
        this.terminate(reason);
      },
    });
  }

  terminate(reason: StreamCancellationReason): void {
    if (this.#settled) return;

    this.#settled = true;
    stopProcess(this.#process);
    void this.#reader.cancel(reason).catch(() => undefined);
  }

  async #readExactly(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let offset = 0;

    while (offset < length) {
      if (this.#pending.length === 0) {
        const next = await this.#reader.read();
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
      const next = await this.#reader.read();
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

function stopProcess(process: ExecProcess): void {
  try {
    process.kill();
  } catch {
    // The process may already have exited.
  }
}
