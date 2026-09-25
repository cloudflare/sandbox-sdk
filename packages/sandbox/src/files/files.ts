import * as z from "zod/mini";

import { runFileCommand } from "./command.js";
import { type FileContent, fileContentStream } from "./content.js";
import {
  readDirectory as readContainerDirectory,
  type SandboxDirectoryEntry,
} from "./read-directory.js";
import { readFile as readContainerFile } from "./read-file.js";
import type { ContainerExecutor } from "../shared/shim.js";
import { type SandboxFileStat, statFile } from "./stat-file.js";
import { writeFile as writeContainerFile } from "./write-file.js";

export interface FileOperationOptions {
  /** Absolute directory that a relative path is joined onto. An absolute path ignores it. */
  cwd?: string;
  /** Numeric user and group IDs that open the file, as `uid:gid`. */
  user?: string;
  /** Cancels the native container process without imposing a timeout. */
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

/** How one option is checked, and what the `TypeError` says after the option's name. */
interface OptionRule {
  readonly schema: z.ZodMiniType;
  readonly requirement: string;
}

/** One rule for every option of `T`, so an option added to the type must also be checked. */
type OptionRules<T> = { readonly [Name in keyof Required<T>]: OptionRule };

const FLAG: OptionRule = { schema: z.boolean(), requirement: "must be a boolean" };

const FILE_OPTIONS = {
  cwd: { schema: z.string().check(z.startsWith("/")), requirement: "must be an absolute path" },
  // A user ID without a group ID runs as root, and names are not resolved, so only numeric
  // uid:gid pairs are accepted.
  user: {
    schema: z.string().check(z.regex(/^[0-9]+:[0-9]+$/)),
    requirement: 'must be numeric user and group IDs, as "uid:gid"',
  },
  signal: { schema: z.instanceof(AbortSignal), requirement: "must be an AbortSignal" },
} satisfies OptionRules<FileOperationOptions>;
const MKDIR_OPTIONS = { ...FILE_OPTIONS, recursive: FLAG } satisfies OptionRules<MkdirOptions>;
const REMOVE_OPTIONS = {
  ...FILE_OPTIONS,
  recursive: FLAG,
  force: FLAG,
} satisfies OptionRules<RemoveOptions>;

const optionsSchema = z.object({});

/**
 * Structured file operations for a sandbox workspace.
 *
 * Operations run against the current native container execution. Its image must provide the matching shim at
 * `/usr/local/bin/sandbox-shim`.
 */
export class Files {
  readonly #container: ContainerExecutor;

  constructor(container: Pick<Container, "exec">) {
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
   * @throws {TypeError} The path is empty, contains NUL, or is relative without `cwd`, or an
   *   option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure before returning the
   *   response. A late file-streaming failure errors the response body with the same error type.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async readFile(path: string, options: FileOperationOptions = {}): Promise<Response> {
    validateOptions(options, FILE_OPTIONS);
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
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async writeFile(
    path: string,
    content: FileContent,
    options: FileOperationOptions = {},
  ): Promise<void> {
    validateOptions(options, FILE_OPTIONS);
    validatePath(path, options.cwd);
    await writeContainerFile(this.#container, path, fileContentStream(content), options);
  }

  /**
   * Returns metadata for a path using native Linux filesystem semantics.
   *
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async stat(path: string, options: FileOperationOptions = {}): Promise<SandboxFileStat> {
    validateOptions(options, FILE_OPTIONS);
    validatePath(path, options.cwd);
    return statFile(this.#container, path, options, "stat");
  }

  /**
   * Returns metadata for a path without following its final symlink.
   *
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async lstat(path: string, options: FileOperationOptions = {}): Promise<SandboxFileStat> {
    validateOptions(options, FILE_OPTIONS);
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
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async readDirectory(
    path: string,
    options: FileOperationOptions = {},
  ): Promise<SandboxDirectoryEntry[]> {
    validateOptions(options, FILE_OPTIONS);
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
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    validateOptions(options, MKDIR_OPTIONS);
    validatePath(path, options.cwd);
    await runFileCommand(this.#container, {
      name: "mkdir",
      paths: [path],
      flags: options.recursive ? ["--recursive"] : [],
      options,
      error: { operation: "mkdir", path },
      expected: "success",
    });
  }

  /**
   * Renames a file, directory, or symlink using native Linux filesystem semantics.
   *
   * Existing destinations are replaced when Linux permits it. Cross-filesystem renames fail
   * with `EXDEV`; no copy-and-remove fallback is attempted.
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} A path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async rename(
    source: string,
    destination: string,
    options: FileOperationOptions = {},
  ): Promise<void> {
    validateOptions(options, FILE_OPTIONS);
    validatePath(source, options.cwd);
    validatePath(destination, options.cwd);
    await runFileCommand(this.#container, {
      name: "rename",
      paths: [source, destination],
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
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async remove(path: string, options: RemoveOptions = {}): Promise<void> {
    validateOptions(options, REMOVE_OPTIONS);
    validatePath(path, options.cwd);
    const flags: string[] = [];
    if (options.recursive) flags.push("--recursive");
    if (options.force) flags.push("--force");
    await runFileCommand(this.#container, {
      name: "remove",
      paths: [path],
      flags,
      options,
      error: { operation: "remove", path },
      expected: "success",
    });
  }
}

// Options set to undefined are ignored, so spreading a wider options object stays valid.
function validateOptions(
  options: FileOperationOptions,
  rules: Readonly<Record<string, OptionRule>>,
): void {
  if (!optionsSchema.safeParse(options).success) {
    throw new TypeError("options must be an object");
  }
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(rules, name)) {
      throw new TypeError(`unknown option "${name}"`);
    }
    const rule = rules[name];
    if (!rule.schema.safeParse(value).success) {
      throw new TypeError(`${name} ${rule.requirement}`);
    }
  }
}

function validatePath(path: string, cwd: string | undefined): void {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Public representation validation.
  if (typeof path !== "string") {
    throw new TypeError("path must be a string");
  }
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
