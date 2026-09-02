const SHIM_PATH = "/usr/local/bin/sandbox-shim";
const MAGIC = new Uint8Array([0x53, 0x42, 0x58, 0x46]);
const PROTOCOL_VERSION = 1;
const HEADER_LENGTH = 6;
const ERROR_PREFIX_LENGTH = 4;
const MAX_ERROR_MESSAGE_LENGTH = 64 * 1024;

const STATUS_OK = 0;
const STATUS_FILE_ERROR = 1;

type StreamCancellationReason = Parameters<ReadableStreamDefaultReader<Uint8Array>["cancel"]>[0];

export interface ReadFileOptions {
  cwd?: string;
  user?: string;
  signal?: AbortSignal;
}

export type ContainerExecutor = Pick<Container, "exec">;

export type SandboxFileErrorCode =
  | "FILE_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "NOT_A_REGULAR_FILE"
  | "FILE_READ_ERROR";

export interface SandboxFileError extends Error {
  code: SandboxFileErrorCode;
  errno?: string;
  path: string;
}

export interface SandboxProtocolError extends Error {
  code: "SANDBOX_PROTOCOL_ERROR";
}

export class ContainerFiles {
  readonly #container: ContainerExecutor;

  constructor(container: ContainerExecutor) {
    this.#container = container;
  }

  async readFile(path: string, options: ReadFileOptions = {}): Promise<Response> {
    validatePath(path, options);

    const execOptions: ContainerExecOptions = {
      stdout: "pipe",
      stderr: "ignore",
    };
    if (options.cwd !== undefined) execOptions.cwd = options.cwd;
    if (options.user !== undefined) execOptions.user = options.user;
    if (options.signal !== undefined) execOptions.signal = options.signal;

    const process = await this.#container.exec([SHIM_PATH, "read", path], execOptions);

    if (process.stdout === null) {
      stopProcess(process);
      throw protocolError("sandbox-shim did not provide stdout");
    }

    const cursor = new StreamCursor(process.stdout.getReader());
    try {
      const header = await cursor.readExactly(HEADER_LENGTH);
      validateHeader(header);

      const status = header[5];
      if (status === STATUS_FILE_ERROR) {
        const errnoBytes = await cursor.readExactly(ERROR_PREFIX_LENGTH);
        const errno = new DataView(
          errnoBytes.buffer,
          errnoBytes.byteOffset,
          ERROR_PREFIX_LENGTH,
        ).getInt32(0, true);
        const message = await cursor.readTextToEnd(MAX_ERROR_MESSAGE_LENGTH);
        throw fileError(path, errno, message);
      }

      if (status !== STATUS_OK) {
        throw protocolError(`sandbox-shim returned unknown status ${status}`);
      }

      return new Response(cursor.toReadableStream(process), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    } catch (error) {
      await cancelProcess(process, cursor, error);
      throw error;
    }
  }
}

function validatePath(path: string, options: ReadFileOptions): void {
  if (path.length === 0) {
    throw new TypeError("path must not be empty");
  }
  if (path.includes("\0")) {
    throw new TypeError("path cannot contain NUL characters");
  }
  if (!path.startsWith("/") && options.cwd === undefined) {
    throw new TypeError("cwd is required when path is relative");
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

function fileError(path: string, errnoNumber: number, detail: string): SandboxFileError {
  const errno = errnoName(errnoNumber);
  const code = fileErrorCode(errnoNumber);
  const suffix = detail.length > 0 ? detail : (errno ?? `errno ${errnoNumber}`);
  const error: SandboxFileError = Object.assign(new Error(`Cannot read '${path}': ${suffix}`), {
    code,
    path,
  });
  if (errno !== undefined) {
    error.errno = errno;
  }
  return error;
}

function fileErrorCode(errno: number): SandboxFileErrorCode {
  switch (errno) {
    case 2:
      return "FILE_NOT_FOUND";
    case 1:
    case 13:
      return "PERMISSION_DENIED";
    case 21:
    case 22:
      return "NOT_A_REGULAR_FILE";
    default:
      return "FILE_READ_ERROR";
  }
}

function errnoName(errno: number): string | undefined {
  switch (errno) {
    case 1:
      return "EPERM";
    case 2:
      return "ENOENT";
    case 5:
      return "EIO";
    case 13:
      return "EACCES";
    case 20:
      return "ENOTDIR";
    case 21:
      return "EISDIR";
    case 22:
      return "EINVAL";
    case 40:
      return "ELOOP";
    default:
      return undefined;
  }
}

function protocolError(message: string): SandboxProtocolError {
  return Object.assign(new Error(message), { code: "SANDBOX_PROTOCOL_ERROR" as const });
}

async function ensureCleanExit(process: ExecProcess): Promise<void> {
  const exitCode = await process.exitCode;
  if (exitCode !== 0) {
    throw protocolError(`sandbox-shim exited with code ${exitCode}`);
  }
}

async function cancelProcess(
  process: ExecProcess,
  cursor: StreamCursor,
  reason: StreamCancellationReason,
): Promise<void> {
  await cursor.cancel(reason).catch(() => undefined);
  stopProcess(process);
}

function stopProcess(process: ExecProcess): void {
  try {
    process.kill();
  } catch {
    // The process may already have exited.
  }
}

class StreamCursor {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #pending: Uint8Array<ArrayBufferLike> = new Uint8Array();

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  async readExactly(length: number): Promise<Uint8Array> {
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

  async readTextToEnd(limit: number): Promise<string> {
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

  cancel(reason: StreamCancellationReason): Promise<void> {
    return this.#reader.cancel(reason);
  }

  toReadableStream(process: ExecProcess): ReadableStream<Uint8Array> {
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

          await ensureCleanExit(process);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        await this.#reader.cancel(reason).catch(() => undefined);
        stopProcess(process);
      },
    });
  }
}
