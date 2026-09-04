import { constants } from "node:os";

/** Symbolic Linux errno, or `UNKNOWN` when the runtime does not name it. */
export type SandboxFileErrorCode = `E${string}` | "UNKNOWN";

const CANONICAL_ERRNO_NAMES = new Map<number, SandboxFileErrorCode>();
for (const [name, value] of Object.entries(constants.errno)) {
  if (name.startsWith("E") && !CANONICAL_ERRNO_NAMES.has(value)) {
    // SAFETY: The prefix check narrows this runtime key to the public errno-code shape.
    CANONICAL_ERRNO_NAMES.set(value, name as `E${string}`);
  }
}
for (const preferred of ["EAGAIN", "EDEADLK", "EOPNOTSUPP"] as const) {
  const value = constants.errno[preferred];
  if (value !== undefined) CANONICAL_ERRNO_NAMES.set(value, preferred);
}

/** Filesystem operation that failed. */
export type SandboxFileOperation =
  | "readFile"
  | "writeFile"
  | "stat"
  | "lstat"
  | "readDirectory"
  | "mkdir"
  | "rename";

type SinglePathFileOperation = Exclude<SandboxFileOperation, "rename">;

export type FileErrorContext =
  | {
      operation: SinglePathFileOperation;
      path: string;
      destination?: undefined;
    }
  | {
      operation: "rename";
      path: string;
      destination: string;
    };

/** Construction contract for {@link SandboxFileError}. */
export type SandboxFileErrorOptions = FileErrorContext & {
  code: SandboxFileErrorCode;
  errno: number;
  detail: string;
};

/** A native Linux filesystem failure reported by the sandbox container. */
export class SandboxFileError extends Error {
  override readonly name = "SandboxFileError";
  readonly code: SandboxFileErrorCode;
  readonly errno: number;
  readonly operation: SandboxFileOperation;
  readonly path: string;
  readonly destination?: string;
  readonly detail: string;

  constructor(options: SandboxFileErrorOptions) {
    if (!Number.isInteger(options.errno) || options.errno <= 0) {
      throw new TypeError("SandboxFileError errno must be a positive integer");
    }
    const subject =
      options.destination === undefined
        ? `'${options.path}'`
        : `'${options.path}' to '${options.destination}'`;
    super(`${options.operation} ${subject}: ${options.detail}`);
    this.code = options.code;
    this.errno = options.errno;
    this.operation = options.operation;
    this.path = options.path;
    if (options.destination !== undefined) this.destination = options.destination;
    this.detail = options.detail;
  }

  /** Recognizes local and JSRPC-crossed SandboxFileError values. */
  static is(cause: unknown): cause is SandboxFileError {
    return (
      cause instanceof Error &&
      cause.name === "SandboxFileError" &&
      hasOwn(cause, "code", isString) &&
      hasOwn(cause, "errno", isPositiveInteger) &&
      hasOwn(cause, "operation", isString) &&
      hasOwn(cause, "path", isString) &&
      hasOptionalOwn(cause, "destination", isString) &&
      hasOwn(cause, "detail", isString)
    );
  }
}

/** Construction contract for {@link SandboxProtocolError}. */
export interface SandboxProtocolErrorOptions {
  detail: string;
  cause?: unknown;
}

/** An incompatible or malformed exchange with `sandbox-shim`. */
export class SandboxProtocolError extends Error {
  override readonly name = "SandboxProtocolError";
  readonly code = "SANDBOX_PROTOCOL_ERROR";
  readonly detail: string;

  constructor(options: SandboxProtocolErrorOptions) {
    super(options.detail, Object.hasOwn(options, "cause") ? { cause: options.cause } : undefined);
    this.detail = options.detail;
  }

  /** Recognizes local and JSRPC-crossed SandboxProtocolError values. */
  static is(cause: unknown): cause is SandboxProtocolError {
    return (
      cause instanceof Error &&
      cause.name === "SandboxProtocolError" &&
      hasOwn(cause, "code", (value) => value === "SANDBOX_PROTOCOL_ERROR") &&
      hasOwn(cause, "detail", isString)
    );
  }
}

export function fileErrorFromErrno(
  context: FileErrorContext,
  errno: number,
  detail: string,
): SandboxFileError {
  const code = CANONICAL_ERRNO_NAMES.get(errno) ?? "UNKNOWN";
  return new SandboxFileError({
    ...context,
    code,
    errno,
    detail: detail.length > 0 ? detail : code,
  });
}

/* oxlint-disable anti-slop/no-unknown-parameters -- JSRPC boundary parses serialized fields. */
function hasOwn<Key extends string, Value>(
  owner: Error,
  key: Key,
  predicate: (value: unknown) => value is Value,
): owner is Error & Record<Key, Value> {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  return descriptor !== undefined && predicate(descriptor.value);
}

function hasOptionalOwn<Key extends string, Value>(
  owner: Error,
  key: Key,
  predicate: (value: unknown) => value is Value,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  return descriptor === undefined || descriptor.value === undefined || predicate(descriptor.value);
}

function isString(value: unknown): value is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- RPC boundary validation.
  return typeof value === "string";
}

function isPositiveInteger(value: unknown): value is number {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- RPC boundary validation.
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
/* oxlint-enable anti-slop/no-unknown-parameters */
