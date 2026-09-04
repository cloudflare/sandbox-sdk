import { type FileContent, fileContentStream } from "./file-content.js";
import { readFile as readContainerFile } from "./read-file.js";
import { type SandboxFileStat, statFile } from "./stat-file.js";
import { writeFile as writeContainerFile } from "./write-file.js";

interface FileOperationOptions {
  /** Working directory used to resolve a relative path. */
  cwd?: string;
  /** Linux user or user/group pair used to open the file. */
  user?: string;
  /** Cancels the native container process without imposing an SDK timeout. */
  signal?: AbortSignal;
}

export type ReadFileOptions = FileOperationOptions;
export type WriteFileOptions = FileOperationOptions;
export type StatOptions = FileOperationOptions;
export type { FileContent } from "./file-content.js";
export type { SandboxFileType } from "./file-type.js";
export type { SandboxFileStat } from "./stat-file.js";

/** Native container capability required by {@link ContainerFiles}. */
export type ContainerExecutor = Pick<Container, "exec">;

/**
 * File operations backed by a native container.
 *
 * The container image must provide the matching shim at
 * `/usr/local/bin/sandbox-shim`.
 */
export class ContainerFiles {
  readonly #container: ContainerExecutor;

  constructor(container: ContainerExecutor) {
    this.#container = container;
  }

  /**
   * Streams bytes from a path in the running container using native Linux file semantics.
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
    return readContainerFile(this.#container, path, options);
  }

  /**
   * Creates or truncates a file and streams content into it using native Linux semantics.
   *
   * The destination is opened before a caller-provided stream is consumed. Failures after that
   * point can leave a created, truncated, or partially written file. Native container, transport,
   * source-stream, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The SDK and sandbox shim cannot complete their protocol.
   */
  async writeFile(
    path: string,
    content: FileContent,
    options: WriteFileOptions = {},
  ): Promise<void> {
    validatePath(path, options.cwd);
    await writeContainerFile(this.#container, path, fileContentStream(content), options);
  }

  /**
   * Returns metadata for a path using native Linux filesystem semantics.
   *
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The SDK and sandbox shim cannot complete their protocol.
   */
  async stat(path: string, options: StatOptions = {}): Promise<SandboxFileStat> {
    validatePath(path, options.cwd);
    return statFile(this.#container, path, options, "stat");
  }

  /**
   * Returns metadata for a path without following its final symlink.
   *
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The SDK and sandbox shim cannot complete their protocol.
   */
  async lstat(path: string, options: StatOptions = {}): Promise<SandboxFileStat> {
    validatePath(path, options.cwd);
    return statFile(this.#container, path, options, "lstat");
  }
}

function validatePath(path: string, cwd: string | undefined): void {
  if (path.length === 0) {
    throw new TypeError("path must not be empty");
  }
  if (path.includes("\0")) {
    throw new TypeError("path cannot contain NUL characters");
  }
  if (cwd !== undefined && !cwd.startsWith("/")) {
    throw new TypeError("cwd must be an absolute path");
  }
  if (!path.startsWith("/") && cwd === undefined) {
    throw new TypeError("cwd is required when path is relative");
  }
}
