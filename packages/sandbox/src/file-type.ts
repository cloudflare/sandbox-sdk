import { protocolError } from "./errors.js";

export type SandboxFileType =
  | "file"
  | "directory"
  | "symlink"
  | "blockDevice"
  | "characterDevice"
  | "fifo"
  | "socket";

export function decodeFileType(value: number | undefined): SandboxFileType {
  switch (value) {
    case 0:
      return "file";
    case 1:
      return "directory";
    case 2:
      return "symlink";
    case 3:
      return "blockDevice";
    case 4:
      return "characterDevice";
    case 5:
      return "fifo";
    case 6:
      return "socket";
    default:
      throw protocolError("sandbox-shim returned an unknown file type");
  }
}
