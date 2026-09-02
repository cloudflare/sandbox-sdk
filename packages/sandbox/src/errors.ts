const SANDBOX_FILE_ERROR_CODES = [
  "FILE_NOT_FOUND",
  "PERMISSION_DENIED",
  "NOT_A_REGULAR_FILE",
  "FILE_READ_ERROR",
] as const;

export type SandboxFileErrorCode = (typeof SANDBOX_FILE_ERROR_CODES)[number];

export type SandboxErrno =
  | "EPERM"
  | "ENOENT"
  | "EIO"
  | "EACCES"
  | "ENOTDIR"
  | "EISDIR"
  | "EINVAL"
  | "ELOOP";

const SANDBOX_PROTOCOL_ERROR_REASONS = [
  "MISSING_STDOUT",
  "INVALID_MAGIC",
  "UNSUPPORTED_VERSION",
  "UNKNOWN_STATUS",
  "TRUNCATED_FRAME",
  "ERROR_MESSAGE_TOO_LARGE",
  "INVALID_ERROR_MESSAGE",
  "UNEXPECTED_EXIT",
] as const;

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

interface SandboxFileErrorOptions {
  code: SandboxFileErrorCode;
  path: string;
  detail: string;
  errno?: SandboxErrno;
}

/** A filesystem failure reported by the sandbox container. */
export class SandboxFileError extends Error {
  override readonly name = "SandboxFileError";
  readonly code: SandboxFileErrorCode;
  readonly path: string;
  readonly detail: string;
  readonly errno?: SandboxErrno;

  constructor(options: SandboxFileErrorOptions) {
    super(`Cannot read '${options.path}': ${options.detail}`);
    this.code = options.code;
    this.path = options.path;
    this.detail = options.detail;
    if (options.errno !== undefined) this.errno = options.errno;
  }

  /** Recognizes local and JSRPC-crossed SandboxFileError values. */
  static is(error: Error): error is SandboxFileError {
    return (
      error.name === "SandboxFileError" &&
      "code" in error &&
      SANDBOX_FILE_ERROR_CODES.some((code) => code === error.code) &&
      "path" in error
    );
  }
}

type SandboxProtocolErrorOptions =
  | { reason: "MISSING_STDOUT" | "INVALID_MAGIC" | "TRUNCATED_FRAME" }
  | { reason: "UNSUPPORTED_VERSION"; protocolVersion: number }
  | { reason: "UNKNOWN_STATUS"; status: number }
  | { reason: "ERROR_MESSAGE_TOO_LARGE"; limit: number }
  | { reason: "INVALID_ERROR_MESSAGE"; cause: unknown }
  | { reason: "UNEXPECTED_EXIT"; exitCode: number };

/** An incompatibility or malformed exchange between the SDK and sandbox shim. */
export class SandboxProtocolError extends Error {
  override readonly name = "SandboxProtocolError";
  readonly code = "SANDBOX_PROTOCOL_ERROR";
  readonly reason: SandboxProtocolErrorReason;
  readonly protocolVersion?: number;
  readonly status?: number;
  readonly limit?: number;
  readonly exitCode?: number;

  constructor(options: SandboxProtocolErrorOptions) {
    super(protocolErrorMessage(options), "cause" in options ? { cause: options.cause } : undefined);
    this.reason = options.reason;
    if ("protocolVersion" in options) this.protocolVersion = options.protocolVersion;
    if ("status" in options) this.status = options.status;
    if ("limit" in options) this.limit = options.limit;
    if ("exitCode" in options) this.exitCode = options.exitCode;
  }

  /** Recognizes local and JSRPC-crossed SandboxProtocolError values. */
  static is(error: Error): error is SandboxProtocolError {
    return (
      error.name === "SandboxProtocolError" &&
      "code" in error &&
      error.code === "SANDBOX_PROTOCOL_ERROR" &&
      "reason" in error &&
      SANDBOX_PROTOCOL_ERROR_REASONS.some((reason) => reason === error.reason)
    );
  }
}

export function fileErrorFromErrno(
  path: string,
  errnoNumber: number,
  detail: string,
): SandboxFileError {
  const metadata = FILE_ERROR_METADATA.get(errnoNumber);
  return new SandboxFileError({
    code: metadata?.code ?? "FILE_READ_ERROR",
    path,
    detail: detail.length > 0 ? detail : (metadata?.errno ?? `errno ${errnoNumber}`),
    errno: metadata?.errno,
  });
}

function protocolErrorMessage(options: SandboxProtocolErrorOptions): string {
  switch (options.reason) {
    case "MISSING_STDOUT":
      return "sandbox-shim did not provide stdout";
    case "INVALID_MAGIC":
      return "sandbox-shim returned invalid protocol magic";
    case "UNSUPPORTED_VERSION":
      return `sandbox-shim protocol ${options.protocolVersion} is not supported`;
    case "UNKNOWN_STATUS":
      return `sandbox-shim returned unknown status ${options.status}`;
    case "TRUNCATED_FRAME":
      return "sandbox-shim closed stdout before completing its frame";
    case "ERROR_MESSAGE_TOO_LARGE":
      return "sandbox-shim error message exceeded its size limit";
    case "INVALID_ERROR_MESSAGE":
      return "sandbox-shim returned a non-UTF-8 error message";
    case "UNEXPECTED_EXIT":
      return `sandbox-shim exited with code ${options.exitCode}`;
  }
}
