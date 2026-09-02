export type SandboxFileErrorCode =
  | "FILE_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "NOT_A_REGULAR_FILE"
  | "FILE_READ_ERROR";

export interface SandboxFileError extends Error {
  code: SandboxFileErrorCode;
  errno?: string;
  path: string;
}

export interface SandboxProtocolError extends Error {
  code: "SANDBOX_PROTOCOL_ERROR";
}

interface FileErrorMetadata {
  code: SandboxFileErrorCode;
  errno: string;
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

export function fileError(path: string, errnoNumber: number, detail: string): SandboxFileError {
  const metadata = FILE_ERROR_METADATA.get(errnoNumber);
  const suffix = detail.length > 0 ? detail : (metadata?.errno ?? `errno ${errnoNumber}`);
  const error: SandboxFileError = Object.assign(new Error(`Cannot read '${path}': ${suffix}`), {
    code: metadata?.code ?? "FILE_READ_ERROR",
    path,
  });
  if (metadata !== undefined) {
    error.errno = metadata.errno;
  }
  return error;
}

export function protocolError(message: string): SandboxProtocolError {
  return Object.assign(new Error(message), { code: "SANDBOX_PROTOCOL_ERROR" as const });
}
