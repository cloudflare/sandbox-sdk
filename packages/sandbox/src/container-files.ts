import { fileErrorFromErrno } from "./errors.js";
import { FramedRead, observeAbort } from "./framed-read.js";

const SHIM_PATH = "/usr/local/bin/sandbox-shim";

export interface ReadFileOptions {
  /** Working directory used to resolve a relative path. */
  cwd?: string;
  /** Linux user or user/group pair used to open the file. */
  user?: string;
  /** Cancels the native container process without imposing an SDK timeout. */
  signal?: AbortSignal;
}

/** Native container capability required by {@link ContainerFiles}. */
export type ContainerExecutor = Pick<Container, "exec">;

/**
 * File operations backed by a native container.
 *
 * The container image must provide the SDK-compatible shim at
 * `/usr/local/bin/sandbox-shim`.
 */
export class ContainerFiles {
  readonly #container: ContainerExecutor;

  constructor(container: ContainerExecutor) {
    this.#container = container;
  }

  /**
   * Streams a regular file from the running container.
   *
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @param path - Absolute path, or a relative path when `options.cwd` is provided.
   * @param options - Native execution options relevant to opening the file.
   * @returns A binary response whose body applies backpressure to the container process. A
   *   file-streaming or native transport failure can surface while the body is consumed.
   * @throws {TypeError} The path is empty, contains NUL, or is relative without `cwd`.
   * @throws {SandboxFileError} The container reports a filesystem failure before returning the
   *   response. A late file-streaming failure errors the response body with the same error type.
   * @throws {SandboxProtocolError} The SDK and sandbox shim cannot complete their protocol.
   */
  async readFile(path: string, options: ReadFileOptions = {}): Promise<Response> {
    validatePath(path, options.cwd);

    const abort = observeAbort(options.signal);
    let process: ExecProcess;
    try {
      const execution = this.#container.exec([SHIM_PATH, "read", path], {
        ...options,
        stdout: "pipe",
        stderr: "ignore",
      });
      process = await (abort === undefined ? execution : Promise.race([abort.promise, execution]));
    } catch (error) {
      abort?.dispose();
      throw error;
    }

    const read = FramedRead.open(process, path, abort);
    try {
      const frame = await read.readFrame();
      if (frame.kind === "error") {
        throw fileErrorFromErrno(path, frame.errno, frame.detail);
      }

      return new Response(read.body(), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    } catch (error) {
      read.terminate(error);
      throw error;
    }
  }
}

function validatePath(path: string, cwd: string | undefined): void {
  if (path.length === 0) {
    throw new TypeError("path must not be empty");
  }
  if (path.includes("\0")) {
    throw new TypeError("path cannot contain NUL characters");
  }
  if (!path.startsWith("/") && cwd === undefined) {
    throw new TypeError("cwd is required when path is relative");
  }
}
