const FILE_ERROR_CODE_ENTRIES = [
  [1, "EPERM"],
  [2, "ENOENT"],
  [3, "ESRCH"],
  [4, "EINTR"],
  [5, "EIO"],
  [6, "ENXIO"],
  [7, "E2BIG"],
  [8, "ENOEXEC"],
  [9, "EBADF"],
  [10, "ECHILD"],
  [11, "EAGAIN"],
  [12, "ENOMEM"],
  [13, "EACCES"],
  [14, "EFAULT"],
  [16, "EBUSY"],
  [17, "EEXIST"],
  [18, "EXDEV"],
  [19, "ENODEV"],
  [20, "ENOTDIR"],
  [21, "EISDIR"],
  [22, "EINVAL"],
  [23, "ENFILE"],
  [24, "EMFILE"],
  [25, "ENOTTY"],
  [26, "ETXTBSY"],
  [27, "EFBIG"],
  [28, "ENOSPC"],
  [29, "ESPIPE"],
  [30, "EROFS"],
  [31, "EMLINK"],
  [32, "EPIPE"],
  [36, "ENAMETOOLONG"],
  [37, "ENOLCK"],
  [38, "ENOSYS"],
  [39, "ENOTEMPTY"],
  [40, "ELOOP"],
  [75, "EOVERFLOW"],
  [122, "EDQUOT"],
] as const;

const SANDBOX_FILE_OPERATIONS = [
  "readFile",
  "writeFile",
  "stat",
  "lstat",
  "readDirectory",
  "mkdir",
  "rename",
  "remove",
] as const;

const SANDBOX_PROTOCOL_ERROR_REASONS = [
  "MISSING_STDIN",
  "MISSING_STDOUT",
  "INVALID_MAGIC",
  "UNSUPPORTED_VERSION",
  "UNKNOWN_STATUS",
  "UNEXPECTED_FRAME",
  "TRUNCATED_FRAME",
  "TRAILING_DATA",
  "INVALID_ERRNO",
  "ERROR_MESSAGE_TOO_LARGE",
  "INVALID_ERROR_MESSAGE",
] as const;

type KnownFileErrorCode = (typeof FILE_ERROR_CODE_ENTRIES)[number][1];
/** Symbolic Linux errno, or `UNKNOWN` when the shim reports an unmapped errno. */
export type SandboxFileErrorCode = KnownFileErrorCode | "UNKNOWN";
/** Filesystem operation that failed. */
export type SandboxFileOperation = (typeof SANDBOX_FILE_OPERATIONS)[number];
/** Stable category for an SDK-to-shim protocol failure. */
export type SandboxProtocolErrorReason = (typeof SANDBOX_PROTOCOL_ERROR_REASONS)[number];

const FILE_ERROR_CODES_BY_ERRNO: ReadonlyMap<number, KnownFileErrorCode> = new Map(
  FILE_ERROR_CODE_ENTRIES,
);

/** Construction contract for {@link SandboxFileError}. */
export interface SandboxFileErrorOptions {
  code: SandboxFileErrorCode;
  operation: SandboxFileOperation;
  path: string;
  destination?: string;
  detail: string;
}

/**
 * A filesystem or file-streaming failure reported by the sandbox container.
 *
 * JSRPC preserves the structured fields with the `enhanced_error_serialization` compatibility
 * flag, enabled by default from 2026-04-21. Consumers should use {@link SandboxFileError.is}
 * because RPC does not preserve custom prototypes.
 */
export class SandboxFileError extends Error {
  override readonly name = "SandboxFileError";
  readonly code: SandboxFileErrorCode;
  readonly operation: SandboxFileOperation;
  readonly path: string;
  readonly detail: string;
  declare readonly destination?: string;

  constructor(options: SandboxFileErrorOptions) {
    validateFileErrorOptions(options);
    super(`${options.operation} '${options.path}': ${options.detail}`);
    this.code = options.code;
    this.operation = options.operation;
    this.path = options.path;
    this.detail = options.detail;
    if (options.destination !== undefined) this.destination = options.destination;
  }

  /** Recognizes local and JSRPC-crossed SandboxFileError values. */
  static is(cause: unknown): cause is SandboxFileError {
    if (
      !(cause instanceof Error) ||
      cause.name !== "SandboxFileError" ||
      !hasOwnProperty(cause, "code", isString) ||
      !isFileErrorCode(cause.code) ||
      !hasOwnProperty(cause, "operation", isString) ||
      !SANDBOX_FILE_OPERATIONS.some((operation) => operation === cause.operation) ||
      !hasOwnProperty(cause, "path", isString) ||
      !hasOwnProperty(cause, "detail", isString)
    ) {
      return false;
    }

    return !Object.hasOwn(cause, "destination") || hasOwnProperty(cause, "destination", isString);
  }
}

function validateFileErrorOptions(options: SandboxFileErrorOptions): void {
  if (!isString(options.code) || !isFileErrorCode(options.code)) {
    throw new TypeError("SandboxFileError code is invalid");
  }
  if (
    !isString(options.operation) ||
    !SANDBOX_FILE_OPERATIONS.some((operation) => operation === options.operation)
  ) {
    throw new TypeError("SandboxFileError operation is invalid");
  }
  if (!isString(options.path) || !isString(options.detail)) {
    throw new TypeError("SandboxFileError path and detail must be strings");
  }
  if (options.destination !== undefined && !isString(options.destination)) {
    throw new TypeError("SandboxFileError destination must be a string");
  }
}

function isFileErrorCode(value: string): value is SandboxFileErrorCode {
  return value === "UNKNOWN" || FILE_ERROR_CODE_ENTRIES.some(([, code]) => code === value);
}

/** Construction contract for {@link SandboxProtocolError}. */
export type SandboxProtocolErrorOptions =
  | {
      reason:
        | "MISSING_STDIN"
        | "MISSING_STDOUT"
        | "INVALID_MAGIC"
        | "UNEXPECTED_FRAME"
        | "TRUNCATED_FRAME"
        | "TRAILING_DATA";
    }
  | { reason: "UNSUPPORTED_VERSION"; protocolVersion: number }
  | { reason: "UNKNOWN_STATUS"; status: number }
  | { reason: "INVALID_ERRNO"; errnoNumber: number }
  | { reason: "ERROR_MESSAGE_TOO_LARGE"; limit: number }
  | { reason: "INVALID_ERROR_MESSAGE"; cause: unknown };

/**
 * An incompatibility or malformed exchange between the SDK and sandbox shim.
 *
 * JSRPC preserves the structured fields with the `enhanced_error_serialization` compatibility
 * flag, enabled by default from 2026-04-21. Consumers should use
 * {@link SandboxProtocolError.is} because RPC does not preserve custom prototypes.
 */
export class SandboxProtocolError extends Error {
  override readonly name = "SandboxProtocolError";
  readonly code = "SANDBOX_PROTOCOL_ERROR";
  readonly reason: SandboxProtocolErrorReason;
  declare readonly protocolVersion?: number;
  declare readonly status?: number;
  declare readonly errnoNumber?: number;
  declare readonly limit?: number;

  constructor(options: SandboxProtocolErrorOptions) {
    validateProtocolErrorOptions(options);
    super(protocolErrorMessage(options), "cause" in options ? { cause: options.cause } : undefined);
    this.reason = options.reason;
    if ("protocolVersion" in options) this.protocolVersion = options.protocolVersion;
    if ("status" in options) this.status = options.status;
    if ("errnoNumber" in options) this.errnoNumber = options.errnoNumber;
    if ("limit" in options) this.limit = options.limit;
  }

  /** Recognizes local and JSRPC-crossed SandboxProtocolError values. */
  static is(cause: unknown): cause is SandboxProtocolError {
    if (
      !(cause instanceof Error) ||
      cause.name !== "SandboxProtocolError" ||
      !hasOwnProperty(cause, "code", isString) ||
      cause.code !== "SANDBOX_PROTOCOL_ERROR" ||
      !hasOwnProperty(cause, "reason", isString)
    ) {
      return false;
    }

    switch (cause.reason) {
      case "MISSING_STDIN":
      case "MISSING_STDOUT":
      case "INVALID_MAGIC":
      case "UNEXPECTED_FRAME":
      case "TRUNCATED_FRAME":
      case "TRAILING_DATA":
        return hasOnlyProtocolMetadata(cause);
      case "UNSUPPORTED_VERSION":
        return (
          hasOnlyProtocolMetadata(cause, "protocolVersion") &&
          hasOwnProperty(cause, "protocolVersion", isProtocolByte)
        );
      case "UNKNOWN_STATUS":
        return (
          hasOnlyProtocolMetadata(cause, "status") &&
          hasOwnProperty(cause, "status", isProtocolByte)
        );
      case "INVALID_ERRNO":
        return (
          hasOnlyProtocolMetadata(cause, "errnoNumber") &&
          hasOwnProperty(cause, "errnoNumber", isInteger) &&
          cause.errnoNumber <= 0
        );
      case "ERROR_MESSAGE_TOO_LARGE":
        return (
          hasOnlyProtocolMetadata(cause, "limit") &&
          hasOwnProperty(cause, "limit", isInteger) &&
          cause.limit > 0
        );
      case "INVALID_ERROR_MESSAGE":
        return hasOnlyProtocolMetadata(cause, "cause");
      default:
        return false;
    }
  }
}

type ProtocolMetadataField = "protocolVersion" | "status" | "errnoNumber" | "limit" | "cause";

function hasOnlyProtocolMetadata(cause: Error, expected?: ProtocolMetadataField): boolean {
  const fields: readonly ProtocolMetadataField[] = [
    "protocolVersion",
    "status",
    "errnoNumber",
    "limit",
    "cause",
  ];
  return fields.every((field) => Object.hasOwn(cause, field) === (field === expected));
}

function validateProtocolErrorOptions(options: SandboxProtocolErrorOptions): void {
  if (
    !isString(options.reason) ||
    !SANDBOX_PROTOCOL_ERROR_REASONS.some((reason) => reason === options.reason)
  ) {
    throw new TypeError("SandboxProtocolError reason is invalid");
  }

  let requiredField: ProtocolMetadataField | undefined;
  switch (options.reason) {
    case "UNSUPPORTED_VERSION":
      requiredField = "protocolVersion";
      break;
    case "UNKNOWN_STATUS":
      requiredField = "status";
      break;
    case "INVALID_ERRNO":
      requiredField = "errnoNumber";
      break;
    case "ERROR_MESSAGE_TOO_LARGE":
      requiredField = "limit";
      break;
    case "INVALID_ERROR_MESSAGE":
      requiredField = "cause";
      break;
  }

  const metadataFields: readonly ProtocolMetadataField[] = [
    "protocolVersion",
    "status",
    "errnoNumber",
    "limit",
    "cause",
  ];
  for (const field of metadataFields) {
    if (Object.hasOwn(options, field) !== (field === requiredField)) {
      throw new TypeError("SandboxProtocolError metadata is inconsistent with its reason");
    }
  }
}

export function fileErrorFromErrno(
  operation: SandboxFileOperation,
  path: string,
  errnoNumber: number,
  detail: string,
): SandboxFileError {
  const code = FILE_ERROR_CODES_BY_ERRNO.get(errnoNumber) ?? "UNKNOWN";
  return new SandboxFileError({
    code,
    operation,
    path,
    detail: detail.length > 0 ? detail : code,
  });
}

export function fileErrorFromExit(
  operation: SandboxFileOperation,
  path: string,
  exitCode: number,
): SandboxFileError {
  return new SandboxFileError({
    code: "EIO",
    operation,
    path,
    detail: `sandbox-shim exited with code ${exitCode}`,
  });
}

function protocolErrorMessage(options: SandboxProtocolErrorOptions): string {
  switch (options.reason) {
    case "MISSING_STDIN":
      return "sandbox-shim did not provide stdin";
    case "MISSING_STDOUT":
      return "sandbox-shim did not provide stdout";
    case "INVALID_MAGIC":
      return "sandbox-shim returned invalid protocol magic";
    case "UNSUPPORTED_VERSION":
      requireProtocolByte(options.protocolVersion, "protocolVersion");
      return `sandbox-shim protocol ${options.protocolVersion} is not supported`;
    case "UNKNOWN_STATUS":
      requireProtocolByte(options.status, "status");
      return `sandbox-shim returned unknown status ${options.status}`;
    case "UNEXPECTED_FRAME":
      return "sandbox-shim returned a frame that is not valid in this position";
    case "TRUNCATED_FRAME":
      return "sandbox-shim closed stdout before completing its frame";
    case "TRAILING_DATA":
      return "sandbox-shim returned data after its terminal frame";
    case "INVALID_ERRNO":
      if (!Number.isInteger(options.errnoNumber) || options.errnoNumber > 0) {
        throw new TypeError("SandboxProtocolError invalid errno must be a non-positive integer");
      }
      return `sandbox-shim returned invalid errno ${options.errnoNumber}`;
    case "ERROR_MESSAGE_TOO_LARGE":
      if (!Number.isInteger(options.limit) || options.limit <= 0) {
        throw new TypeError("SandboxProtocolError limit must be a positive integer");
      }
      return "sandbox-shim error message exceeded its size limit";
    case "INVALID_ERROR_MESSAGE":
      return "sandbox-shim returned a non-UTF-8 error message";
  }
}

function hasOwnProperty<Key extends string, Value>(
  owner: Error,
  key: Key,
  isValue: (cause: unknown) => cause is Value,
): owner is Error & Record<Key, Value> {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  return descriptor !== undefined && isValue(descriptor.value);
}

function isString(cause: unknown): cause is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary parser narrows a primitive.
  return typeof cause === "string";
}

function isInteger(cause: unknown): cause is number {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary parser narrows a primitive.
  return typeof cause === "number" && Number.isInteger(cause);
}

function isProtocolByte(cause: unknown): cause is number {
  return isInteger(cause) && cause >= 0 && cause <= 255;
}

function requireProtocolByte(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new TypeError(`SandboxProtocolError ${name} must be a byte`);
  }
}
