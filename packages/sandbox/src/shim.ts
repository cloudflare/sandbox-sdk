import type { ContainerExecutor } from "./container-files.js";
import { SandboxProtocolError } from "./errors.js";

export const SHIM_PATH = "/usr/local/bin/sandbox-shim";

const MAGIC = new Uint8Array([0x53, 0x42, 0x58, 0x46]);
const PROTOCOL_VERSION = 3;
const HEADER_LENGTH = 10;
const ERROR_PREFIX_LENGTH = 4;
const MAX_ERROR_MESSAGE_LENGTH = 64 * 1024;

const FRAME_SUCCESS = 0;
const FRAME_FILE_ERROR = 1;

type CancellationReason = Parameters<ReadableStreamDefaultReader<Uint8Array>["cancel"]>[0];

export type ShimControlFrame =
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

  openControl(): ShimControl {
    if (this.process.stderr === null) {
      throw new SandboxProtocolError({ detail: "sandbox-shim did not provide stderr" });
    }
    return new ShimControl(this.process.stderr.getReader(), this);
  }

  openOutputControl(): ShimControl {
    if (this.process.stdout === null) {
      throw new SandboxProtocolError({ detail: "sandbox-shim did not provide stdout" });
    }
    return new ShimControl(this.process.stdout.getReader(), this);
  }

  openOutput(): ReadableStreamDefaultReader<Uint8Array> {
    if (this.process.stdout === null) {
      throw new SandboxProtocolError({ detail: "sandbox-shim did not provide stdout" });
    }
    return this.process.stdout.getReader();
  }

  openInput(): WritableStreamDefaultWriter<Uint8Array> {
    if (this.process.stdin === null) {
      throw new SandboxProtocolError({ detail: "sandbox-shim did not provide stdin" });
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

export class ShimControl {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #session: ShimSession;
  #pending: Uint8Array<ArrayBufferLike> = new Uint8Array();

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>, session: ShimSession) {
    this.#reader = reader;
    this.#session = session;
  }

  async readFrame(): Promise<ShimControlFrame> {
    const header = await this.#readExactly(HEADER_LENGTH);
    validateHeader(header);
    const frameKind = header[5];
    const payloadLength = new DataView(header.buffer, header.byteOffset + 6, 4).getUint32(0, true);

    if (frameKind === FRAME_SUCCESS) {
      if (payloadLength !== 0) {
        throw new SandboxProtocolError({ detail: "sandbox-shim returned invalid control data" });
      }
      return { kind: "success" };
    }
    if (frameKind !== FRAME_FILE_ERROR) {
      throw new SandboxProtocolError({
        detail: `sandbox-shim returned unknown control status ${frameKind}`,
      });
    }
    if (payloadLength < ERROR_PREFIX_LENGTH) {
      throw new SandboxProtocolError({ detail: "sandbox-shim returned invalid control data" });
    }
    if (payloadLength > ERROR_PREFIX_LENGTH + MAX_ERROR_MESSAGE_LENGTH) {
      throw new SandboxProtocolError({
        detail: "sandbox-shim error message exceeded its size limit",
      });
    }

    const payload = await this.#readExactly(payloadLength);
    const errno = new DataView(payload.buffer, payload.byteOffset, ERROR_PREFIX_LENGTH).getInt32(
      0,
      true,
    );
    if (errno <= 0) {
      throw new SandboxProtocolError({ detail: `sandbox-shim returned invalid errno ${errno}` });
    }
    return {
      kind: "fileError",
      errno,
      detail: decodeErrorDetail(payload.subarray(ERROR_PREFIX_LENGTH)),
    };
  }

  async expectEnd(): Promise<void> {
    const trailing =
      this.#pending.length === 0
        ? await this.#session.waitFor(this.#reader.read())
        : { done: false as const, value: this.#pending };
    if (!trailing.done) {
      throw new SandboxProtocolError({ detail: "sandbox-shim returned trailing control data" });
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
          throw new SandboxProtocolError({
            detail: "sandbox-shim returned truncated control data",
          });
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
    throw new SandboxProtocolError({
      detail: "sandbox-shim returned a non-UTF-8 error message",
      cause,
    });
  }
}

function validateHeader(header: Uint8Array): void {
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (header[index] !== MAGIC[index]) {
      throw new SandboxProtocolError({ detail: "sandbox-shim returned invalid protocol magic" });
    }
  }
  if (header[4] !== PROTOCOL_VERSION) {
    throw new SandboxProtocolError({
      detail: `sandbox-shim protocol ${header[4]} is not supported`,
    });
  }
}
