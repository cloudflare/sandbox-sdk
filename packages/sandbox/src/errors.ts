const SANDBOX_FILE_ERROR_CODES = [
  "FILE_NOT_FOUND",
  "PERMISSION_DENIED",
  "NOT_A_REGULAR_FILE",
  "FILE_READ_ERROR",
] as const;

const SANDBOX_ERRNOS = [
  "EPERM",
  "ENOENT",
  "EIO",
  "EACCES",
  "ENOTDIR",
  "EISDIR",
  "EINVAL",
  "ELOOP",
] as const;

const SANDBOX_PROTOCOL_ERROR_REASONS = [
  "MISSING_STDOUT",
  "INVALID_MAGIC",
  "UNSUPPORTED_VERSION",
  "UNKNOWN_STATUS",
  "TRUNCATED_FRAME",
  "INVALID_ERRNO",
  "ERROR_MESSAGE_TOO_LARGE",
  "INVALID_ERROR_MESSAGE",
] as const;

/** Stable category for a sandbox file failure. */
export type SandboxFileErrorCode = (typeof SANDBOX_FILE_ERROR_CODES)[number];
/** Symbolic Linux errno recognized by the SDK. */
export type SandboxErrno = (typeof SANDBOX_ERRNOS)[number];
/** Stable category for an SDK-to-shim protocol failure. */
export type SandboxProtocolErrorReason = (typeof SANDBOX_PROTOCOL_ERROR_REASONS)[number];

interface FileErrorMetadata {
  code: SandboxFileErrorCode;
  errno: SandboxErrno;
}

const FILE_ERROR_METADATA: ReadonlyMap<number, FileErrorMetadata> = new Map([
  [1, { code: "PERMISSION_DENIED", errno: "EPERM" }],
  [2, { code: "FILE_NOT_FOUND", errno: "ENOENT" }],
  [5, { code: "FILE_READ_ERROR", errno: "EIO" }],
  [13, { code: "PERMISSION_DENIED", errno: "EACCES" }],
  [20, { code: "FILE_READ_ERROR", errno: "ENOTDIR" }],
  [21, { code: "NOT_A_REGULAR_FILE", errno: "EISDIR" }],
  [22, { code: "NOT_A_REGULAR_FILE", errno: "EINVAL" }],
  [40, { code: "FILE_READ_ERROR", errno: "ELOOP" }],
]);

/** Construction contract for {@link SandboxFileError}. */
export type SandboxFileErrorOptions =
  | {
      path: string;
      detail: string;
      errnoNumber: number;
      exitCode?: never;
    }
  | {
      path: string;
      detail: string;
      errnoNumber?: never;
      exitCode: number;
    };

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
  readonly path: string;
  readonly detail: string;
  declare readonly errnoNumber?: number;
  declare readonly errno?: SandboxErrno;
  declare readonly exitCode?: number;

  constructor(options: SandboxFileErrorOptions) {
    validateFileErrorOptions(options);
    super(`Cannot read '${options.path}': ${options.detail}`);
    const metadata =
      options.errnoNumber === undefined ? undefined : FILE_ERROR_METADATA.get(options.errnoNumber);
    this.code = metadata?.code ?? "FILE_READ_ERROR";
    this.path = options.path;
    this.detail = options.detail;
    if (options.errnoNumber !== undefined) this.errnoNumber = options.errnoNumber;
    if (metadata !== undefined) this.errno = metadata.errno;
    if (options.exitCode !== undefined) this.exitCode = options.exitCode;
  }

  /** Recognizes local and JSRPC-crossed SandboxFileError values. */
  static is(cause: unknown): cause is SandboxFileError {
    if (
      !(cause instanceof Error) ||
      cause.name !== "SandboxFileError" ||
      !hasOwnProperty(cause, "code", isString) ||
      !SANDBOX_FILE_ERROR_CODES.some((code) => code === cause.code) ||
      !hasOwnProperty(cause, "path", isString) ||
      !hasOwnProperty(cause, "detail", isString)
    ) {
      return false;
    }

    const ownsErrnoNumber = Object.hasOwn(cause, "errnoNumber");
    const ownsExitCode = Object.hasOwn(cause, "exitCode");
    if (ownsErrnoNumber === ownsExitCode) return false;

    if (ownsExitCode) {
      return (
        hasOwnProperty(cause, "exitCode", isInteger) &&
        cause.code === "FILE_READ_ERROR" &&
        !Object.hasOwn(cause, "errno")
      );
    }

    if (!hasOwnProperty(cause, "errnoNumber", isInteger) || cause.errnoNumber <= 0) return false;
    const metadata = FILE_ERROR_METADATA.get(cause.errnoNumber);
    if (metadata === undefined) {
      return cause.code === "FILE_READ_ERROR" && !Object.hasOwn(cause, "errno");
    }

    return (
      cause.code === metadata.code &&
      hasOwnProperty(cause, "errno", isString) &&
      cause.errno === metadata.errno
    );
  }
}

function validateFileErrorOptions(options: SandboxFileErrorOptions): void {
  if (!isString(options.path) || !isString(options.detail)) {
    throw new TypeError("SandboxFileError path and detail must be strings");
  }

  const hasExitCode = options.exitCode !== undefined;
  const hasErrnoNumber = options.errnoNumber !== undefined;
  if (hasExitCode === hasErrnoNumber) {
    throw new TypeError("SandboxFileError requires exactly one numeric error source");
  }

  if (hasExitCode) {
    if (!Number.isInteger(options.exitCode)) {
      throw new TypeError("SandboxFileError exitCode must be an integer");
    }
    return;
  }

  if (!Number.isInteger(options.errnoNumber) || options.errnoNumber <= 0) {
    throw new TypeError("SandboxFileError errnoNumber must be a positive integer");
  }
}

/** Construction contract for {@link SandboxProtocolError}. */
export type SandboxProtocolErrorOptions =
  | { reason: "MISSING_STDOUT" | "INVALID_MAGIC" | "TRUNCATED_FRAME" }
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
      case "MISSING_STDOUT":
      case "INVALID_MAGIC":
      case "TRUNCATED_FRAME":
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
  path: string,
  errnoNumber: number,
  detail: string,
): SandboxFileError {
  const metadata = FILE_ERROR_METADATA.get(errnoNumber);
  return new SandboxFileError({
    path,
    detail: detail.length > 0 ? detail : (metadata?.errno ?? `errno ${errnoNumber}`),
    errnoNumber,
  });
}

export function fileErrorFromExit(path: string, exitCode: number): SandboxFileError {
  return new SandboxFileError({
    path,
    detail: `sandbox-shim exited with code ${exitCode}`,
    exitCode,
  });
}

function protocolErrorMessage(options: SandboxProtocolErrorOptions): string {
  switch (options.reason) {
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
    case "TRUNCATED_FRAME":
      return "sandbox-shim closed stdout before completing its frame";
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
