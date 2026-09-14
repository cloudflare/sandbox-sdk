import { constants } from "node:os";

/** Symbolic Linux errno, or `UNKNOWN` when the runtime does not name it. */
type SandboxFileErrorCode = `E${string}` | "UNKNOWN";

const FILE_OPERATIONS = [
  "readFile",
  "writeFile",
  "stat",
  "lstat",
  "readDirectory",
  "mkdir",
  "rename",
  "remove",
] as const;

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
type SandboxFileOperation = (typeof FILE_OPERATIONS)[number];

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

/** A native Linux filesystem failure reported by the sandbox container. */
export interface SandboxFileError extends Error {
  readonly name: "SandboxFileError";
  readonly code: SandboxFileErrorCode;
  readonly operation: SandboxFileOperation;
  readonly path: string;
  readonly destination?: string;
  readonly detail: string;
}

class FileError extends Error implements SandboxFileError {
  override readonly name = "SandboxFileError";
  readonly code: SandboxFileErrorCode;
  readonly operation: SandboxFileOperation;
  readonly path: string;
  readonly destination?: string;
  readonly detail: string;

  constructor(context: FileErrorContext, code: SandboxFileErrorCode, detail: string) {
    const subject =
      context.destination === undefined
        ? `'${context.path}'`
        : `'${context.path}' to '${context.destination}'`;
    super(`${context.operation} ${subject}: ${detail}`);
    this.code = code;
    this.operation = context.operation;
    this.path = context.path;
    if (context.destination !== undefined) this.destination = context.destination;
    this.detail = detail;
  }
}

export const SandboxFileError = {
  /** Recognizes local and JSRPC-crossed SandboxFileError values. */
  is(cause: unknown): cause is SandboxFileError {
    return (
      cause instanceof Error &&
      cause.name === "SandboxFileError" &&
      hasOwn(cause, "code", isFileErrorCode) &&
      hasOwn(cause, "operation", isFileOperation) &&
      hasOwn(cause, "path", isString) &&
      hasOptionalOwn(cause, "destination", isString) &&
      hasOwn(cause, "detail", isString)
    );
  },
};

/** An incompatible or malformed exchange with `sandbox-shim`. */
export interface SandboxProtocolError extends Error {
  readonly name: "SandboxProtocolError";
  readonly code: "SANDBOX_PROTOCOL_ERROR";
  readonly detail: string;
}

/* oxlint-disable anti-slop/no-unknown-parameters -- Error causes and RPC guards are arbitrary. */
class ProtocolError extends Error implements SandboxProtocolError {
  override readonly name = "SandboxProtocolError";
  readonly code = "SANDBOX_PROTOCOL_ERROR";
  readonly detail: string;

  constructor(detail: string, cause?: unknown) {
    super(detail, cause === undefined ? undefined : { cause });
    this.detail = detail;
  }
}

export const SandboxProtocolError = {
  /** Recognizes local and JSRPC-crossed SandboxProtocolError values. */
  is(cause: unknown): cause is SandboxProtocolError {
    return (
      cause instanceof Error &&
      cause.name === "SandboxProtocolError" &&
      hasOwn(cause, "code", (value) => value === "SANDBOX_PROTOCOL_ERROR") &&
      hasOwn(cause, "detail", isString)
    );
  },
};

export function protocolError(detail: string, cause?: unknown): SandboxProtocolError {
  return new ProtocolError(detail, cause);
}

export function fileErrorFromErrno(
  context: FileErrorContext,
  errno: number,
  detail: string,
): SandboxFileError {
  const code = CANONICAL_ERRNO_NAMES.get(errno) ?? "UNKNOWN";
  return new FileError(context, code, detail.length > 0 ? detail : code);
}

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

function isFileErrorCode(value: unknown): value is SandboxFileErrorCode {
  return isString(value) && (value === "UNKNOWN" || /^E[A-Z0-9]+$/.test(value));
}

function isFileOperation(value: unknown): value is SandboxFileOperation {
  return FILE_OPERATIONS.some((operation) => operation === value);
}

/* oxlint-enable anti-slop/no-unknown-parameters */
