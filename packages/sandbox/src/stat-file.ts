import type { ContainerExecutor } from "./container-files.js";
import { SandboxProtocolError, type SandboxFileOperation } from "./errors.js";
import { decodeFileType, type SandboxFileType } from "./file-type.js";
import { runFileQuery } from "./file-query.js";

const STAT_PAYLOAD_LENGTH = 45;

export interface SandboxFileStat {
  type: SandboxFileType;
  size: bigint;
  mode: number;
  uid: number;
  gid: number;
  accessedAt: Date;
  modifiedAt: Date;
  changedAt: Date;
}

export async function statFile(
  container: ContainerExecutor,
  path: string,
  options: ContainerExecOptions,
  operation: Extract<SandboxFileOperation, "stat" | "lstat">,
): Promise<SandboxFileStat> {
  const payload = await runFileQuery(container, [operation, path], options, operation, path);
  if (payload.length !== STAT_PAYLOAD_LENGTH) {
    throw new SandboxProtocolError({ detail: `sandbox-shim returned invalid ${operation} data` });
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    type: decodeFileType(payload[0]),
    size: view.getBigUint64(1, true),
    mode: view.getUint32(9, true),
    uid: view.getUint32(13, true),
    gid: view.getUint32(17, true),
    accessedAt: decodeDate(view.getBigInt64(21, true)),
    modifiedAt: decodeDate(view.getBigInt64(29, true)),
    changedAt: decodeDate(view.getBigInt64(37, true)),
  };
}

function decodeDate(milliseconds: bigint): Date {
  const value = Number(milliseconds);
  if (!Number.isSafeInteger(value)) {
    throw new SandboxProtocolError({ detail: "sandbox-shim returned an out-of-range timestamp" });
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new SandboxProtocolError({ detail: "sandbox-shim returned an out-of-range timestamp" });
  }
  return date;
}
