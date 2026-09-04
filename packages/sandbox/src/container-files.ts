import { runFileCommand } from "./file-command.js";
import { type FileContent, fileContentStream } from "./file-content.js";
import {
  readDirectory as readContainerDirectory,
  type SandboxDirectoryEntry,
} from "./read-directory.js";
import { readFile as readContainerFile } from "./read-file.js";
import { type SandboxFileStat, statFile } from "./stat-file.js";
import { writeFile as writeContainerFile } from "./write-file.js";

export interface FileOperationOptions {
  /** Working directory used to resolve a relative path. */
  cwd?: string;
  /** Linux user or user/group pair used to open the file. */
  user?: string;
  /** Cancels the native container process without imposing an SDK timeout. */
  signal?: AbortSignal;
}

export type RemoveOptions = FileOperationOptions & {
  /** Permits removing a directory tree without following symlinks. */
  recursive?: boolean;
  /** Ignores a missing target. */
  force?: boolean;
};
export type MkdirOptions = FileOperationOptions & {
  /** Creates missing parent directories and accepts an existing target directory. */
  recursive?: boolean;
};

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
  async readFile(path: string, options: FileOperationOptions = {}): Promise<Response> {
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
    options: FileOperationOptions = {},
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
  async stat(path: string, options: FileOperationOptions = {}): Promise<SandboxFileStat> {
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
  async lstat(path: string, options: FileOperationOptions = {}): Promise<SandboxFileStat> {
    validatePath(path, options.cwd);
    return statFile(this.#container, path, options, "lstat");
  }

  /**
   * Returns the immediate entries from a directory in native enumeration order.
   *
   * The directory path may resolve through a symlink, but entry types describe the entries
   * themselves and do not follow symlinks. The operation does not recurse or retrieve metadata
   * for each child.
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The SDK and sandbox shim cannot complete their protocol.
   */
  async readDirectory(
    path: string,
    options: FileOperationOptions = {},
  ): Promise<SandboxDirectoryEntry[]> {
    validatePath(path, options.cwd);
    return readContainerDirectory(this.#container, path, options);
  }

  /**
   * Creates a directory using native Linux filesystem semantics.
   *
   * By default only the final directory is created. With `recursive`, missing parents are
   * created and an existing target directory is accepted. Partial parent creation can remain
   * after failure or cancellation.
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The SDK and sandbox shim cannot complete their protocol.
   */
  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    validatePath(path, options.cwd);
    const { recursive = false, ...execOptions } = options;
    const command = recursive ? ["mkdir", path, "--recursive"] : ["mkdir", path];
    await runFileCommand(this.#container, {
      command,
      options: execOptions,
      error: { operation: "mkdir", path },
      expected: "success",
    });
  }

  /**
   * Renames a file, directory, or symlink using native Linux filesystem semantics.
   *
   * Existing destinations are replaced when Linux permits it. Cross-filesystem renames fail
   * with `EXDEV`; the SDK does not fall back to copying and removing the source.
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} A path is empty, contains NUL, or is relative without an absolute `cwd`.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The SDK and sandbox shim cannot complete their protocol.
   */
  async rename(
    source: string,
    destination: string,
    options: FileOperationOptions = {},
  ): Promise<void> {
    validatePath(source, options.cwd);
    validatePath(destination, options.cwd);
    await runFileCommand(this.#container, {
      command: ["rename", source, destination],
      options,
      error: { operation: "rename", path: source, destination },
      expected: "success",
    });
  }

  /**
   * Removes a file or symlink using native Linux filesystem semantics.
   *
   * Directories are rejected unless `recursive` is set. Recursive removal does not follow
   * symlinks and can leave partial effects after failure or cancellation. `force` ignores only
   * a missing target. Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The SDK and sandbox shim cannot complete their protocol.
   */
  async remove(path: string, options: RemoveOptions = {}): Promise<void> {
    validatePath(path, options.cwd);
    const { recursive = false, force = false, ...execOptions } = options;
    const command = ["remove", path];
    if (recursive) command.push("--recursive");
    if (force) command.push("--force");
    await runFileCommand(this.#container, {
      command,
      options: execOptions,
      error: { operation: "remove", path },
      expected: "success",
    });
  }
}

function validatePath(path: string, cwd: string | undefined): void {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Public representation validation.
  if (typeof path !== "string") {
    throw new TypeError("path must be a string");
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Public representation validation.
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new TypeError("cwd must be a string");
  }
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
