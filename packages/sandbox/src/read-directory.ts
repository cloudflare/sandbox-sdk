import type { ContainerExecutor } from "./container-files.js";
import { protocolError } from "./errors.js";
import { runFileCommand } from "./file-command.js";
import { decodeFileType, type SandboxFileType } from "./file-type.js";

export interface SandboxDirectoryEntry {
  name: string;
  type: SandboxFileType;
}

export async function readDirectory(
  container: ContainerExecutor,
  path: string,
  options: ContainerExecOptions,
): Promise<SandboxDirectoryEntry[]> {
  const payload = await runFileCommand(container, {
    command: ["read-directory", path],
    options,
    error: { operation: "readDirectory", path },
    expected: "data",
  });
  return decodeEntries(payload);
}

function decodeEntries(payload: Uint8Array): SandboxDirectoryEntry[] {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;
  const count = readUint32(view, offset);
  offset += 4;
  const entries: SandboxDirectoryEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    const type = decodeFileType(readByte(payload, offset));
    offset += 1;
    const nameLength = readUint16(view, offset);
    offset += 2;
    const name = decodeText(readBytes(payload, offset, nameLength));
    offset += nameLength;
    entries.push({ name, type });
  }

  if (offset !== payload.length) {
    throw protocolError("sandbox-shim returned trailing directory data");
  }
  return entries;
}

function readByte(payload: Uint8Array, offset: number): number {
  const value = payload[offset];
  if (value === undefined) {
    throw protocolError("sandbox-shim returned truncated directory data");
  }
  return value;
}

function readUint16(view: DataView, offset: number): number {
  if (offset + 2 > view.byteLength) {
    throw protocolError("sandbox-shim returned truncated directory data");
  }
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  if (offset + 4 > view.byteLength) {
    throw protocolError("sandbox-shim returned truncated directory data");
  }
  return view.getUint32(offset, true);
}

function readBytes(payload: Uint8Array, offset: number, length: number): Uint8Array {
  if (offset + length > payload.length) {
    throw protocolError("sandbox-shim returned truncated directory data");
  }
  return payload.subarray(offset, offset + length);
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw protocolError("sandbox-shim returned invalid UTF-8 in directory entry name", cause);
  }
}
