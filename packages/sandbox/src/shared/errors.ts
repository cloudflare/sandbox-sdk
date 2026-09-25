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
  "backup",
  "restore",
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

export type SandboxS3MountErrorCode =
  | "S3_MOUNT_CONFLICT"
  | "S3_MOUNT_BUSY"
  | "S3_MOUNT_FAILED"
  | "S3_MOUNT_INCOMPATIBLE";

export type S3MountOperation = "mount" | "inspect" | "unmount";

/** A classifiable failure while reconciling an S3-compatible filesystem mount. */
export interface SandboxS3MountError extends Error {
  readonly name: "SandboxS3MountError";
  readonly code: SandboxS3MountErrorCode;
  readonly operation: S3MountOperation;
  readonly path: string;
  readonly detail: string;
}

class S3MountError extends Error implements SandboxS3MountError {
  override readonly name = "SandboxS3MountError";
  readonly code: SandboxS3MountErrorCode;
  readonly operation: S3MountOperation;
  readonly path: string;
  readonly detail: string;

  constructor(
    code: SandboxS3MountErrorCode,
    operation: S3MountOperation,
    path: string,
    detail: string,
  ) {
    super(`${operation} '${path}': ${detail}`);
    this.code = code;
    this.operation = operation;
    this.path = path;
    this.detail = detail;
  }
}

export const SandboxS3MountError = {
  /** Recognizes local and JSRPC-crossed SandboxS3MountError values. */
  is(cause: unknown): cause is SandboxS3MountError {
    return (
      cause instanceof Error &&
      cause.name === "SandboxS3MountError" &&
      hasOwn(cause, "code", isS3MountErrorCode) &&
      hasOwn(cause, "operation", isS3MountOperation) &&
      hasOwn(cause, "path", isString) &&
      hasOwn(cause, "detail", isString)
    );
  },
};

export type SandboxBackupErrorCode = "BACKUP_NOT_FOUND" | "BACKUP_INTEGRITY" | "BACKUP_TRANSFER";

export type DirectoryBackupOperation = "backup" | "restore" | "delete";

/** A failure specific to a directory backup: a missing, altered, or unreachable object. */
export interface SandboxBackupError extends Error {
  readonly name: "SandboxBackupError";
  readonly code: SandboxBackupErrorCode;
  readonly operation: DirectoryBackupOperation;
  /** The directory being backed up or restored, or the record's directory for `delete`. */
  readonly path: string;
  readonly detail: string;
}

class BackupError extends Error implements SandboxBackupError {
  override readonly name = "SandboxBackupError";
  readonly code: SandboxBackupErrorCode;
  readonly operation: DirectoryBackupOperation;
  readonly path: string;
  readonly detail: string;

  constructor(
    code: SandboxBackupErrorCode,
    operation: DirectoryBackupOperation,
    path: string,
    detail: string,
  ) {
    super(`${operation} '${path}': ${detail}`);
    this.code = code;
    this.operation = operation;
    this.path = path;
    this.detail = detail;
  }
}

export const SandboxBackupError = {
  /** Recognizes local and JSRPC-crossed SandboxBackupError values. */
  is(cause: unknown): cause is SandboxBackupError {
    return (
      cause instanceof Error &&
      cause.name === "SandboxBackupError" &&
      hasOwn(cause, "code", isBackupErrorCode) &&
      hasOwn(cause, "operation", isBackupOperation) &&
      hasOwn(cause, "path", isString) &&
      hasOwn(cause, "detail", isString)
    );
  },
};

export function backupError(
  code: SandboxBackupErrorCode,
  operation: DirectoryBackupOperation,
  path: string,
  detail: string,
): SandboxBackupError {
  return new BackupError(code, operation, path, detail);
}

export function protocolError(detail: string, cause?: unknown): SandboxProtocolError {
  return new ProtocolError(detail, cause);
}

export function s3MountError(
  code: SandboxS3MountErrorCode,
  operation: S3MountOperation,
  path: string,
  detail: string,
): SandboxS3MountError {
  return new S3MountError(code, operation, path, detail);
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

function isS3MountErrorCode(value: unknown): value is SandboxS3MountErrorCode {
  return (
    value === "S3_MOUNT_CONFLICT" ||
    value === "S3_MOUNT_BUSY" ||
    value === "S3_MOUNT_FAILED" ||
    value === "S3_MOUNT_INCOMPATIBLE"
  );
}

function isBackupErrorCode(value: unknown): value is SandboxBackupErrorCode {
  return (
    value === "BACKUP_NOT_FOUND" || value === "BACKUP_INTEGRITY" || value === "BACKUP_TRANSFER"
  );
}

function isBackupOperation(value: unknown): value is DirectoryBackupOperation {
  return value === "backup" || value === "restore" || value === "delete";
}

function isS3MountOperation(value: unknown): value is S3MountOperation {
  return value === "mount" || value === "inspect" || value === "unmount";
}

/* oxlint-enable anti-slop/no-unknown-parameters */
