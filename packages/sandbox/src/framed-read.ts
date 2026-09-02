import { protocolError } from "./errors.js";

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
  #pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #settled = false;

  private constructor(process: ExecProcess, reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#process = process;
    this.#reader = reader;
  }

  static open(process: ExecProcess): FramedRead {
    if (process.stdout === null) {
      stopProcess(process);
      throw protocolError("sandbox-shim did not provide stdout");
    }

    return new FramedRead(process, process.stdout.getReader());
  }

  async readFrame(): Promise<ReadFrame> {
    const header = await this.#readExactly(HEADER_LENGTH);
    validateHeader(header);

    const status = header[5];
    if (status === STATUS_OK) {
      return { kind: "content" };
    }
    if (status !== STATUS_FILE_ERROR) {
      throw protocolError(`sandbox-shim returned unknown status ${status}`);
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
            throw protocolError(`sandbox-shim exited with code ${exitCode}`);
          }

          this.#settled = true;
          controller.close();
        } catch (error) {
          this.terminate(error);
          controller.error(error);
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
          throw protocolError("sandbox-shim closed stdout before completing its frame");
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
        throw protocolError("sandbox-shim error message exceeded its size limit");
      }
      const next = await this.#reader.read();
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.length;
    }

    if (length > limit) {
      throw protocolError("sandbox-shim error message exceeded its size limit");
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw protocolError("sandbox-shim returned a non-UTF-8 error message");
    }
  }
}

function validateHeader(header: Uint8Array): void {
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (header[index] !== MAGIC[index]) {
      throw protocolError("sandbox-shim returned invalid protocol magic");
    }
  }
  if (header[4] !== PROTOCOL_VERSION) {
    throw protocolError(`sandbox-shim protocol ${header[4]} is not supported`);
  }
}

function stopProcess(process: ExecProcess): void {
  try {
    process.kill();
  } catch {
    // The process may already have exited.
  }
}
