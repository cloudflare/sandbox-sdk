import { SandboxProtocolError } from "./errors.js";
import type { ContainerExecutor } from "./container-files.js";

export const SHIM_PATH = "/usr/local/bin/sandbox-shim";

const MAGIC = new Uint8Array([0x53, 0x42, 0x58, 0x46]);
const PROTOCOL_VERSION = 2;
const HEADER_LENGTH = 10;
const ERROR_PREFIX_LENGTH = 4;
const MAX_ERROR_MESSAGE_LENGTH = 64 * 1024;
const MAX_DATA_LENGTH = 64 * 1024;

const FRAME_SUCCESS = 0;
const FRAME_FILE_ERROR = 1;
const FRAME_DATA = 2;

type CancellationReason = Parameters<ReadableStreamDefaultReader<Uint8Array>["cancel"]>[0];

export type ShimFrame =
  | { readonly kind: "success" }
  | { readonly kind: "fileError"; readonly errno: number; readonly detail: string }
  | { readonly kind: "data"; readonly value: Uint8Array };

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
    const frameKind = header[5];
    const payloadLength = new DataView(header.buffer, header.byteOffset + 6, 4).getUint32(0, true);

    if (frameKind === FRAME_SUCCESS) {
      if (payloadLength !== 0) throw new SandboxProtocolError({ reason: "UNEXPECTED_FRAME" });
      return { kind: "success" };
    }
    if (frameKind === FRAME_DATA) {
      if (payloadLength === 0 || payloadLength > MAX_DATA_LENGTH) {
        throw new SandboxProtocolError({ reason: "UNEXPECTED_FRAME" });
      }
      return { kind: "data", value: await this.#readExactly(payloadLength) };
    }
    if (frameKind !== FRAME_FILE_ERROR) {
      throw new SandboxProtocolError({ reason: "UNKNOWN_STATUS", status: frameKind });
    }
    if (payloadLength < ERROR_PREFIX_LENGTH) {
      throw new SandboxProtocolError({ reason: "UNEXPECTED_FRAME" });
    }
    if (payloadLength > ERROR_PREFIX_LENGTH + MAX_ERROR_MESSAGE_LENGTH) {
      throw new SandboxProtocolError({
        reason: "ERROR_MESSAGE_TOO_LARGE",
        limit: MAX_ERROR_MESSAGE_LENGTH,
      });
    }

    const payload = await this.#readExactly(payloadLength);
    const errno = new DataView(payload.buffer, payload.byteOffset, ERROR_PREFIX_LENGTH).getInt32(
      0,
      true,
    );
    if (errno <= 0) {
      throw new SandboxProtocolError({ reason: "INVALID_ERRNO", errnoNumber: errno });
    }
    const detail = decodeErrorDetail(payload.subarray(ERROR_PREFIX_LENGTH));
    return { kind: "fileError", errno, detail };
  }

  async expectEnd(): Promise<void> {
    const trailing =
      this.#pending.length === 0
        ? await this.#session.waitFor(this.#reader.read())
        : { done: false as const, value: this.#pending };
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
}

function decodeErrorDetail(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new SandboxProtocolError({ reason: "INVALID_ERROR_MESSAGE", cause });
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
