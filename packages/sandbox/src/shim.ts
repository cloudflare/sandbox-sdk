import { SandboxProtocolError } from "./errors.js";
import type { ContainerExecutor } from "./container-files.js";

export const SHIM_PATH = "/usr/local/bin/sandbox-shim";

const MAGIC = new Uint8Array([0x53, 0x42, 0x58, 0x46]);
const PROTOCOL_VERSION = 1;
const HEADER_LENGTH = 6;
const ERROR_PREFIX_LENGTH = 4;
const MAX_ERROR_MESSAGE_LENGTH = 64 * 1024;

const STATUS_OK = 0;
const STATUS_FILE_ERROR = 1;

type CancellationReason = Parameters<ReadableStreamDefaultReader<Uint8Array>["cancel"]>[0];

export type ShimFrame =
  | { readonly kind: "success" }
  | { readonly kind: "fileError"; readonly errno: number; readonly detail: string };

class AbortMonitor {
  readonly #promise: Promise<never> | undefined;
  #dispose: () => void = () => undefined;

  constructor(signal: AbortSignal | undefined) {
    if (signal === undefined) return;

    this.#promise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }

      const onAbort = () => {
        this.dispose();
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#dispose = () => signal.removeEventListener("abort", onAbort);
    });
    void this.#promise.catch(() => undefined);
  }

  waitFor<Value>(operation: Promise<Value>): Promise<Value> {
    if (this.#promise === undefined) return operation;
    return Promise.race([this.#promise, operation]);
  }

  dispose(): void {
    this.#dispose();
    this.#dispose = () => undefined;
  }
}

export class ShimSession {
  readonly process: ExecProcess;
  readonly #abort: AbortMonitor;
  #settled = false;

  private constructor(process: ExecProcess, abort: AbortMonitor) {
    this.process = process;
    this.#abort = abort;
  }

  static async start(
    container: ContainerExecutor,
    command: string[],
    options: ContainerExecOptions,
  ): Promise<ShimSession> {
    const abort = new AbortMonitor(options.signal);
    try {
      const process = await abort.waitFor(container.exec(command, options));
      return new ShimSession(process, abort);
    } catch (error) {
      abort.dispose();
      throw error;
    }
  }

  openOutput(): ShimOutput {
    if (this.process.stdout === null) {
      throw new SandboxProtocolError({ reason: "MISSING_STDOUT" });
    }
    return new ShimOutput(this.process.stdout.getReader(), this);
  }

  openInput(): WritableStreamDefaultWriter<Uint8Array> {
    if (this.process.stdin === null) {
      throw new SandboxProtocolError({ reason: "MISSING_STDIN" });
    }
    return this.process.stdin.getWriter();
  }

  waitFor<Value>(operation: Promise<Value>): Promise<Value> {
    return this.#abort.waitFor(operation);
  }

  finish(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#abort.dispose();
  }

  terminate(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#abort.dispose();
    try {
      this.process.kill(9);
    } catch {
      // The process may already have exited.
    }
  }
}

export class ShimOutput {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #session: ShimSession;
  #pending: Uint8Array<ArrayBufferLike> = new Uint8Array();

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>, session: ShimSession) {
    this.#reader = reader;
    this.#session = session;
  }

  async readFrame(): Promise<ShimFrame> {
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
    return { kind: "fileError", errno, detail };
  }

  read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (this.#pending.length === 0) return this.#session.waitFor(this.#reader.read());

    const value = this.#pending;
    this.#pending = new Uint8Array();
    return Promise.resolve({ done: false, value });
  }

  async expectEnd(): Promise<void> {
    const trailing = await this.read();
    if (!trailing.done) {
      throw new SandboxProtocolError({ reason: "TRAILING_DATA" });
    }
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

  async #readExactly(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let offset = 0;

    while (offset < length) {
      if (this.#pending.length === 0) {
        const next = await this.#session.waitFor(this.#reader.read());
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
      const next = await this.#session.waitFor(this.#reader.read());
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
